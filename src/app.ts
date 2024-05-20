import { ApplicationFunction, Probot } from 'probot'
import { ApplicationFunctionOptions } from 'probot/lib/types'
import { Router, Request, Response } from 'express'
import { IssueCommentCreatedEvent, PullRequestReviewCommentCreatedEvent } from '@octokit/webhooks-types'
import { RestEndpointMethodTypes } from '@octokit/plugin-rest-endpoint-methods'
import { getCidChecker, pool } from './Dependency'
import { Criteria } from './checker/CidChecker'

const handler: ApplicationFunction = (app: Probot, _options: ApplicationFunctionOptions): void => {
  if (_options.getRouter != null) {
    const healthRoute: Router = _options.getRouter('/health')
    healthRoute.get('/', async (_: Request, res: Response) => {
      try {
        let out = await pool.query('SELECT 1')
        if (out.rowCount === 1) {
          res.status(200).send('OK')
          return
        }
      } catch(e) {
        // pass through
      }
      res.status(500).send('Database error')
      return
    })

    const reportRoute: Router = _options.getRouter('/check')

    reportRoute.get('/', async (req: Request, res: Response) => {
      if (req.query.issue === undefined || req.query.repo === undefined || typeof req.query.repo !== 'string' || typeof req.query.issue !== 'string') {
        res.status(400).send('Missing issue or repo')
        return
      }

      const retrievabilityThreshold = parseFloat(process.env.RETRIEVABILITY_WARNING_THRESHOLD ?? '0.2')
      const retrievabilityRange = parseInt(process.env.RETRIEVABILITY_RANGE_DAYS ?? '7')

      const criteria: Criteria[] = JSON.parse(process.env.CRITERIA ?? '[]')

      if (criteria.length === 0 || criteria.some(c =>
        c.lowReplicaThreshold === undefined ||
        c.maxDuplicationPercentage === undefined ||
        c.maxProviderDealPercentage === undefined ||
        c.maxPercentageForLowReplica === undefined)) {
        throw new Error('Invalid environment variable CRITERIA')
      }

      const checker = getCidChecker(app.log.child({ contextId: req.id }))

      type Params = RestEndpointMethodTypes['issues']['get']['parameters']
      type Response = RestEndpointMethodTypes['issues']['get']['response']
      const ownerSplit = req.query.repo.split('/')
      const issueId = req.query.issue
      const params: Params = {
        owner: ownerSplit[0],
        repo: ownerSplit[1],
        issue_number: parseInt(issueId)
      }
      app.log(`Fetching issue ${issueId}`)
      let response: Response
      try {
        response = await checker.octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}', params)
      } catch (e) {
        res.end('Error fetching issue ' + issueId)
        return
      }

      const result = await checker.check({
        issue: response.data,
        repository: {
          owner: {
            login: ownerSplit[0]
          },
          name: ownerSplit[1],
          full_name: req.query.repo
        }
      } as any, criteria, [], retrievabilityThreshold, retrievabilityRange)
      if (result === undefined) {
        app.log.info('No comment to post')
        return
      }

      if(result[1] == null) {
        res.contentType('text/plain').send(result[0])
      } else {
        res.contentType('text/plain').send(result[0] + result[1])
      }
    })
  }

  app.on(['issues.labeled', 'issue_comment.created', 'pull_request_review_comment.created'], async (context) => {
    const otherAddresses: string[] = []
    if (context.payload.action === 'labeled') {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion,@typescript-eslint/no-non-null-asserted-optional-chain
      if (!process.env.TARGET_LABEL!.split(',').includes(context.payload.label?.name!)) {
        return
      }
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    } else if (!context.payload.comment.body.trim().startsWith(process.env.TARGET_COMMENT!)) {
      return
    } else {
      const addresses = context.payload.comment.body.trim().split(/\s+/).slice(1).filter(s => s.match(/[0-9a-zA-Z]+/))
      otherAddresses.push(...addresses)
    }

    const retrievabilityThreshold = parseFloat(process.env.RETRIEVABILITY_WARNING_THRESHOLD ?? '0.2')
    const retrievabilityRange = parseInt(process.env.RETRIEVABILITY_RANGE_DAYS ?? '7')

    const criteria: Criteria[] = JSON.parse(process.env.CRITERIA ?? '[]')
    if (criteria.length === 0 || criteria.some(c =>
      c.lowReplicaThreshold === undefined ||
      c.maxDuplicationPercentage === undefined ||
      c.maxProviderDealPercentage === undefined ||
      c.maxPercentageForLowReplica === undefined)) {
      throw new Error('Invalid environment variable CRITERIA')
    }
    const checker = getCidChecker(app.log.child({ contextId: context.id }), context.octokit)
    if (context.payload.action === 'created' && context.name !== 'issues' && context.name !== 'issue_comment') {
      const pre: PullRequestReviewCommentCreatedEvent = context.payload as PullRequestReviewCommentCreatedEvent

      const result = await checker.checkFromPR(pre, criteria, otherAddresses, retrievabilityThreshold, retrievabilityRange)
      if (result === undefined) {
        app.log.info('No comment to post')
        return
      }
      app.log({ body: result })
      const issueComment = context.issue({
        body: result[0]
      })

      if (process.env.DRY_RUN !== 'true' && process.env.DRY_RUN !== '1') {
        await context.octokit.issues.createComment(issueComment)
      }

      return
    }
    const icce: IssueCommentCreatedEvent = context.payload as IssueCommentCreatedEvent
    const result = await checker.check(icce, criteria, otherAddresses, retrievabilityThreshold, retrievabilityRange)
    if (result === undefined) {
      app.log.info('No comment to post')
      return
    }
    app.log({ body: result })
    const issueComment = context.issue({
      body: result[0]
    })

    if (process.env.DRY_RUN !== 'true' && process.env.DRY_RUN !== '1') {
      await context.octokit.issues.createComment(issueComment)
    }
  })
}

export = handler
