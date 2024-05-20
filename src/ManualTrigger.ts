import { APIGatewayProxyEventV2, APIGatewayProxyResult, Context } from 'aws-lambda'
import { getCidChecker } from './Dependency'
import pino from 'pino'
import { RestEndpointMethodTypes } from '@octokit/plugin-rest-endpoint-methods'
import * as dotenv from 'dotenv'

export async function manualTrigger (event: APIGatewayProxyEventV2, _: Context): Promise<APIGatewayProxyResult> {
  dotenv.config()

  const retrievabilityWarningIndicator = parseFloat(process.env.RETRIEVABILITY_WARNING_THRESHOLD ?? '0.2')
  const retrievabilityRange = parseInt(process.env.RETRIEVABILITY_RANGE_DAYS ?? '7')

  const issueId = event.queryStringParameters?.issueId
  const repo = event.queryStringParameters?.repo
  const otherAddresses: string[] = event.queryStringParameters?.otherAddresses?.split(' ') ?? []
  if (issueId === undefined) {
    return {
      statusCode: 400,
      body: 'Missing issueId'
    }
  }
  if (repo === undefined) {
    return {
      statusCode: 400,
      body: 'Missing repo'
    }
  }
  const ownerSplit = repo.split('/')
  if (ownerSplit.length !== 2) {
    return {
      statusCode: 400,
      body: 'Invalid repo'
    }
  }

  const logger = pino()
  const cidchecker = getCidChecker(logger)
  type Params = RestEndpointMethodTypes['issues']['get']['parameters']
  type Response = RestEndpointMethodTypes['issues']['get']['response']
  const params: Params = {
    owner: ownerSplit[0],
    repo: ownerSplit[1],
    issue_number: parseInt(issueId)
  }
  logger.info(`Fetching issue ${issueId}`)
  let response: Response
  try {
    response = await cidchecker.octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}', params)
  } catch (e) {
    return {
      statusCode: 500,
      body: 'Error fetching issue ' + issueId
    }
  }
  const result = await cidchecker.check({
    issue: response.data,
    repository: {
      owner: {
        login: ownerSplit[0]
      },
      name: ownerSplit[1],
      full_name: repo
    }
  } as any, [{
    maxProviderDealPercentage: 0.25,
    maxDuplicationPercentage: 0.20,
    maxPercentageForLowReplica: 0.25,
    lowReplicaThreshold: 3
  }], otherAddresses, retrievabilityWarningIndicator, retrievabilityRange)

  return {
    statusCode: 200,
    body: result[0]
  }
}
