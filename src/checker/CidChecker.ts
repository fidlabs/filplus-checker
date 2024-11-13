import { Octokit } from '@octokit/core'
import { RestEndpointMethodTypes } from '@octokit/plugin-rest-endpoint-methods'
import { Issue, PullRequestReviewCommentCreatedEvent, Repository } from '@octokit/webhooks-types'
import retry from 'async-retry'
import axios from 'axios'
import { Chart, LegendOptions } from 'chart.js'
import { resolve4, resolve6 } from 'dns/promises'
import * as fs from 'fs'
import { Multiaddr } from 'multiaddr'
import emoji from 'node-emoji'
import ordinal from 'ordinal'
import { dirname, join as pathJoin } from 'path'
import { Pool } from 'pg'
import { Logger } from 'pino'
import xbytes from 'xbytes'
import BarChart, { BarChartEntry } from '../charts/BarChart'
import GeoMap, { GeoMapEntry } from '../charts/GeoMap'
import { parseIssue } from '../ldn-parser-functions/parseIssue'
import { isNotEmpty } from '../utils/typeGuards'
import { escape, generateGfmTable, generateLink, wrapInCode } from './MarkdownUtils'
import {
  ApplicationInfo,
  CidSharing,
  CidSharingRow,
  GetVerifiedClientResponse,
  IpInfoResponse,
  Location,
  MinerInfo,
  ProviderDistribution,
  ProviderDistributionRow,
  ProviderDistributionWithLocation,
  ReplicationDistribution,
  ReplicationDistributionRow,
  Retrievability,
  SparkSuccessRate
} from './Types'
import { DatacapAllocation } from './application'

const RED = 'rgba(255, 99, 132)'
const GREEN = 'rgba(75, 192, 192)'

export interface FileUploadConfig {
  local: string | undefined
  localBaseURL: string
  owner: string
  repo: string
  branch?: string
  committerName: string
  committerEmail: string
}

export interface Criteria {
  maxProviderDealPercentage: number
  maxDuplicationPercentage: number
  lowReplicaThreshold: number
  maxPercentageForLowReplica: number
}

export default class CidChecker {
  private static readonly ErrorTemplate = `
  ## DataCap and CID Checker Report[^1]
  {message}

  [^1]: To manually trigger this report, add a comment with text \`checker:manualTrigger\`
  `

  private static getErrorContent (message: string): string {
    return CidChecker.ErrorTemplate.replace('{message}', message)
  }

  // private static readonly GetClientShortIdQuery = `SELECT client, client_address
  //                                                 from client_mapping
  //                                                 where client_address = ANY ($1)`
  private static readonly issueApplicationInfoCache: Map<string, ApplicationInfo | null> = new Map()
  private static readonly ProviderDistributionQuery = `
   SELECT provider,
        total_deal_size,
        unique_data_size,
        (total_deal_size::FLOAT - unique_data_size) / total_deal_size::FLOAT AS duplication_percentage
  FROM provider_distribution
  WHERE client = ANY ($1)
  ORDER BY total_deal_size DESC;`

  private static readonly ReplicaDistributionQuery = 'SELECT * FROM replica_distribution where client = ANY ($1)'
  private static readonly LatestGeneratedReportQuery = 'select * from generated_reports where client_address_id = ($1) order by created_at desc limit 1'
  private static readonly AllGeneratedReportsQuery = 'select * from generated_reports where client_address_id = ($1) order by created_at desc'

  private static readonly CidSharingQuery = 'SELECT * FROM cid_sharing WHERE client = ANY ($1)'

  public constructor (
    private readonly sql: Pool,
    public readonly octokit: Octokit,
    private readonly fileUploadConfig: FileUploadConfig,
    private readonly logger: Logger,
    private readonly ipinfoToken: string,
  ) {
  }

  private getClientAddress (issue: Issue): string | undefined {
    const { address } = parseIssue(issue.body ?? '')
    if (address == null || address[0] !== 'f') {
      this.logger.warn('Could not find address in issue %s', issue.number)
      return undefined
    }
    this.logger.info(`Found address ${address} for issue ${issue.number}`)
    return address
  }

  private static getCurrentEpoch (): number {
    return Math.floor((Date.now() / 1000 - 1598306400) / 30)
  }

  // private async getClientShortIDs (clientAddresses: string[]): Promise<string[]> {
  //  const result = await retry(async () => await this.sql.query(CidChecker.GetClientShortIdQuery, [clientAddresses]), { retries: 3 })
  //  return result.rows.map((row: any) => row.client)
  // }

  private async getFirstClientByProviders (providers: string[]): Promise<Array<{ provider: string, first_client: string }>> {
    const params = []
    for (let i = 1; i <= providers.length; i++) {
      params.push('$' + i.toString())
    }
    const firstClientQuery = `
      SELECT * FROM providers WHERE provider IN (${params.join(',')})`
    this.logger.info({ firstClientQuery, providers })
    const queryResult = await retry(async () => await this.sql.query(firstClientQuery, providers), { retries: 3 })
    const rows: Array<{ provider: string, first_client: string }> = queryResult.rows
    return rows
  }

  private async getStorageProviderDistribution (clientIds: string[]): Promise<ProviderDistribution[]> {
    this.logger.info({ clientIds }, 'Getting storage provider distribution')
    const queryResult = await retry(async () => await this.sql.query(
      CidChecker.ProviderDistributionQuery,
      [clientIds]), { retries: 3 })
    const distributions = queryResult.rows as ProviderDistribution[]
    const total = distributions.reduce((acc, cur) => acc + parseFloat(cur.total_deal_size), 0)
    for (const distribution of distributions) {
      distribution.percentage = parseFloat(distribution.total_deal_size) / total
    }
    this.logger.debug({ distributions }, 'Got Storage provider distribution')
    return distributions
  }

  private async getReplicationDistribution (clientIds: string[]): Promise<ReplicationDistribution[]> {
    const currentEpoch = CidChecker.getCurrentEpoch()
    this.logger.info({ clientIds, currentEpoch }, 'Getting replication distribution')
    const queryResult = await retry(async () => await this.sql.query(
      CidChecker.ReplicaDistributionQuery,
      [clientIds]), { retries: 3 })
    const distributions = queryResult.rows as ReplicationDistribution[]
    const total = distributions.reduce((acc, cur) => acc + parseFloat(cur.total_deal_size), 0)
    for (const distribution of distributions) {
      distribution.percentage = parseFloat(distribution.total_deal_size) / total
    }
    this.logger.debug({ distributions }, 'Got replication distribution')
    return distributions
  }

  private async getCidSharing (clientIds: string[]): Promise<CidSharing[]> {
    this.logger.info({ clientIds }, 'Getting cid sharing')
    const queryResult = await retry(async () => await this.sql.query(
      CidChecker.CidSharingQuery,
      [clientIds]), { retries: 3 })
    const sharing = queryResult.rows as CidSharing[]
    this.logger.debug({ sharing }, 'Got cid sharing')
    return sharing
  }

  private async uploadFile (path: string, base64Content: string, commitMessage: string): Promise<[download_url: string, html_url: string]> {
    const { local, owner, repo } = this.fileUploadConfig
    type Params = RestEndpointMethodTypes['repos']['createOrUpdateFileContents']['parameters']
    type Response = RestEndpointMethodTypes['repos']['createOrUpdateFileContents']['response']
    const params: Params = {
      owner,
      repo,
      path,
      message: commitMessage,
      content: base64Content,
      branch: this.fileUploadConfig.branch,
      committer: {
        name: this.fileUploadConfig.committerName,
        email: this.fileUploadConfig.committerEmail
      }
    }

    this.logger.info({
      owner: params.owner,
      repo: params.repo,
      path: params.path,
      message: params.message
    }, 'Uploading file')

    if (local) {
      const base = dirname(path)
      const fullPath = pathJoin(local, base)
      const fullURL = this.fileUploadConfig.localBaseURL + path
      try {
        fs.mkdirSync(fullPath, { recursive: true })
        fs.writeFileSync(pathJoin(local, path), Buffer.from(base64Content, 'base64'))
        return [fullURL, fullURL]
      } catch (e) {
        this.logger.error('Error uploading file %s: %s', params.path, e)
        return ['', '']
      }
    }

    try {
      const response: Response = await retry(async () => {
        try {
          return await this.octokit.request('PUT /repos/{owner}/{repo}/contents/{path}', params)
        } catch (e: any) {
          this.logger.error('Error uploading file', e.toString())
          throw e
        }
      }, { retries: 3 })
      this.logger.info({
        owner: params.owner,
        repo: params.repo,
        path: params.path,
        message: params.message
      }, 'Uploaded file')
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      return [response.data.content!.download_url!, response.data.content!.html_url!]
    } catch (error: any) {
      this.logger.error('Error uploading file %s: %s', params.path, error.message)
      return ['', '']
    }
  }

  private getImageForReplicationDistribution (replicationDistributions: ReplicationDistribution[], colorThreshold: number): string {
    const replicationEntries: BarChartEntry[] = []

    for (const distribution of replicationDistributions) {
      replicationEntries.push({
        yValue: parseFloat(distribution.unique_data_size),
        xValue: distribution.num_of_replicas,
        barLabel: xbytes(parseFloat(distribution.unique_data_size), { iec: true }),
        label: distribution.num_of_replicas.toString()
      })
    }

    const backgroundColors = replicationEntries.map((row) => row.xValue <= colorThreshold ? RED : GREEN)
    const borderColors = replicationEntries.map((row) => row.xValue <= colorThreshold ? RED : GREEN)

    // not sure why typescript is complaining here on labels
    // ive nested the Partial as well and its still complaining
    // leaving labels as any for now.
    const legendOpts: Partial<LegendOptions<'bar'> & { labels: any }> = {
      display: true,
      labels: {
        generateLabels: (_: Chart<'bar'>) => [
          { text: 'low provider count', fillStyle: RED, strokeStyle: '#fff' },
          { text: 'healthy provider count', fillStyle: GREEN, strokeStyle: '#fff' }
        ]
      }
    }

    return BarChart.getImage(replicationEntries, {
      title: 'Unique Data Bytes by Number of Providers',
      titleYText: 'Unique Data Bytes',
      titleXText: 'Number of Providers',
      legendOpts,
      backgroundColors,
      borderColors
    })
  }

  private getImageForProviderDistribution (providerDistributions: ProviderDistributionWithLocation[]): string {
    const geoMapEntries: GeoMapEntry[] = []

    for (const distribution of providerDistributions) {
      if (distribution.longitude != null && distribution.latitude != null) {
        geoMapEntries.push({
          longitude: distribution.longitude,
          latitude: distribution.latitude,
          value: distribution.percentage,
          label: distribution.provider
        })
      }
    }
    return GeoMap.getImage(geoMapEntries)
  }

  private async findApplicationInfoForClient (client: string): Promise<ApplicationInfo | null> {
    if (CidChecker.issueApplicationInfoCache.has(client)) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      return CidChecker.issueApplicationInfoCache.get(client)!
    }
    this.logger.info({ client }, 'Finding application info for client')
    const response = await retry(async () => await axios.get(
      `https://api.datacapstats.io/api/getVerifiedClients?limit=10&page=1&filter=${client}`), { retries: 6 })
    const data: GetVerifiedClientResponse = response.data
    if (data.data.length === 0) {
      CidChecker.issueApplicationInfoCache.set(client, null)
      return null
    }
    const primary = data.data.reduce((prev, curr) => parseInt(prev.initialAllowance) > parseInt(curr.initialAllowance) ? prev : curr)
    const result = {
      clientAddress: client,
      organizationName: (primary.name ?? '') + (primary.orgName ?? ''),
      url: primary.allowanceArray[0]?.auditTrail,
      verifier: primary.verifierName,
      issueNumber: primary.allowanceArray[0]?.auditTrail?.split('/').pop(),
      numberOfAllocations: primary.allowanceArray.length
    }
    CidChecker.issueApplicationInfoCache.set(client, result)
    return result
  }

  private static linkifyAddress (address: string): string {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    return `[${address.match(/.{1,41}/g)!.join('<br/>')}](https://filfox.info/en/address/${address})`
  }

  private static linkifyApplicationInfo (applicationInfo: ApplicationInfo | null): string {
    return applicationInfo != null
      ? (applicationInfo.url != null
          ? `[${escape(applicationInfo.organizationName)}](${applicationInfo.url})`
          : wrapInCode(applicationInfo.organizationName))
      : 'Unknown'
  }

  private async getIpFromMultiaddr (multiAddr: string): Promise<string[]> {
    const m = new Multiaddr(Buffer.from(multiAddr, 'base64'))
    const address = m.nodeAddress().address
    const proto = m.protos()[0].name
    switch (proto) {
      case 'dns4':
        return await resolve4(address)
      case 'dns6':
        return await resolve6(address)
      case 'ip4':
      case 'ip6':
        return [address]
      default:
        this.logger.error({ multiAddr }, 'Unknown protocol')
        return []
    }
  }

  private async getMinerInfo (miner: string): Promise<MinerInfo> {
    this.logger.info({ miner }, 'Getting miner info')
    return await retry(async () => {
      const response = await axios.post('https://api.node.glif.io/rpc/v0', {
        jsonrpc: '2.0',
        id: 1,
        method: 'Filecoin.StateMinerInfo',
        params: [
          miner, null
        ]
      })
      return response.data.result
    }, { retries: 3 })
  }

  private static renderApprovers (approvers: Array<[string, number]>): string {
    return approvers.map(([name, count]) => `${wrapInCode(count.toString())}${name}`).join('<br/>')
  }

  private static readonly prCache = new Map<number, any>()

  private async getRecordByPR (prNumber: number, repo: Repository): Promise<DatacapAllocation> {
    if (CidChecker.prCache.has(prNumber)) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      return CidChecker.prCache.get(prNumber)!
    }
    type Params = RestEndpointMethodTypes['pulls']['get']['parameters']
    const params: Params = {
      owner: repo.owner.login,
      repo: repo.name,
      pull_number: prNumber
    }
    this.logger.info(params, 'Getting PR')
    const response: any | null = await retry(async () => await this.octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}/files', params), { retries: 3 })
    if (response == null) {
      throw new Error('Failed to get PR')
    }
    const editedFile: string = response.data[0].contents_url

    const editedFileData = await this.octokit.request(`GET ${editedFile}`, {})

    const outData = atob(editedFileData.data.content)
    const outRecord: DatacapAllocation = JSON.parse(outData)

    CidChecker.prCache.set(prNumber, outRecord)
    return outRecord
  }

  private async getIssueForRecord (record: DatacapAllocation, repo: Repository): Promise<Issue> {
    const issueNum = record['Issue Number']

    const params = {
      owner: repo.owner,
      repo: repo.name,
      issueNum
    }
    // type IssueResponse = RestEndpointMethodTypes['issues']['get']['response']

    const response: any = await retry(async () => await this.octokit.request('GET /repos/{owner}/{repo}/issues/{issueNum}', params), { retries: 3 })

    const ri: Issue = {
      number: response.data.number,
      title: response.data.title,
      body: response.data.body!,
      user: {
        name: response.data.user!.name!,
        login: response.data.user!.login!,
        id: response.data.user!.id!,
        node_id: response.data.user!.node_id!,
        avatar_url: response.data.user!.avatar_url!,
        gravatar_id: response.data.user!.gravatar_id!,
        url: response.data.user!.url!,
        html_url: response.data.user!.html_url!,
        followers_url: response.data.user!.followers_url!,
        following_url: response.data.user!.following_url!,
        gists_url: response.data.user!.gists_url!,
        starred_url: response.data.user!.starred_url!,
        subscriptions_url: response.data.user!.subscriptions_url!,
        organizations_url: response.data.user!.organizations_url!,
        repos_url: response.data.user!.repos_url!,
        events_url: response.data.user!.events_url!,
        received_events_url: response.data.user!.received_events_url!,
        type: 'User',
        site_admin: response.data.user!.site_admin!
      },
      url: response.data.html_url,
      repository_url: response.data.repository_url,
      labels_url: response.data.labels_url,
      comments_url: response.data.comments_url,
      events_url: response.data.events_url,
      html_url: response.data.html_url,
      id: response.data.id,
      node_id: response.data.node_id,
      assignees: [],
      milestone: null,
      comments: response.data.comments,
      created_at: response.data.created_at,
      updated_at: response.data.updated_at,
      closed_at: response.data.closed_at,
      author_association: response.data.author_association,
      active_lock_reason: null,
      reactions: response.data.reactions!
    }

    return ri
  }

  private static readonly commentsCache = new Map<string, Array<{
    body?: string
    user: { login: string | undefined, id: number } | undefined | null
    performed_via_github_app?: { id: number } | undefined | null
  }>>()

  private async getComments (issueNumber: number, repo: Repository): Promise<Array<{
    body?: string
    user: { login: string | undefined, id: number } | undefined | null
    performed_via_github_app?: { id: number } | undefined | null
  }>> {
    const key = `${repo.owner.login}/${repo.name}/${issueNumber}`
    if (CidChecker.commentsCache.has(key)) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      return CidChecker.commentsCache.get(key)!
    }
    type Params = RestEndpointMethodTypes['issues']['listComments']['parameters']
    type Response = RestEndpointMethodTypes['issues']['listComments']['response']
    let page = 1
    const comments = []
    while (true) {
      const params: Params = {
        owner: repo.owner.login,
        repo: repo.name,
        issue_number: issueNumber,
        per_page: 100,
        page
      }
      this.logger.info(params, 'Getting comments for issue')
      const response: Response | null = await retry(async () => {
        try {
          return await this.octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}/comments', params)
        } catch (e) {
          if ((e as any).status === 404) {
            return null
          }
          throw e
        }
      }, { retries: 3 })
      if (response != null) {
        comments.push(...response.data)
      }
      if (response == null || response.data.length < 100) {
        break
      }
      page++
    }

    CidChecker.commentsCache.set(key, comments)
    return comments
  }

  private async getApprovers (issueNumber: number, repo: Repository): Promise<Array<[string, number]>> {
    const approvers = new Map<string, number>()
    const comments = await this.getComments(issueNumber, repo)
    for (const comment of comments) {
      if (comment.body?.startsWith('## Request Approved') === true ||
        comment.body?.startsWith('## Request Proposed') === true) {
        const approver = comment.user?.login ?? 'Unknown'
        const count = approvers.get(approver) ?? 0
        approvers.set(approver, count + 1)
      }
    }
    return [...approvers.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }

  private async getLocation (provider: string): Promise<Location | null> {
    const minerInfo = await this.getMinerInfo(provider)
    if (minerInfo.Multiaddrs == null || minerInfo.Multiaddrs.length === 0) {
      return null
    }
    const ips: string[] = []
    for (const multiAddr of minerInfo.Multiaddrs) {
      this.logger.info({ multiAddr }, 'Getting IP from multiaddr')
      try {
        const ip = await this.getIpFromMultiaddr(multiAddr)
        ips.push(...ip)
      } catch (e) {
        this.logger.warn({ multiAddr, e }, 'Failed to get IP from multiaddr')
        return null
      }
    }
    for (const ip of ips) {
      this.logger.info({ ip }, 'Getting location for IP')
      const data = await retry(async () => {
        const response = await axios.get(`https://ipinfo.io/${ip}?token=${this.ipinfoToken}`)
        return response.data
      }, { retries: 3 }) as IpInfoResponse
      if (data.bogon === true) {
        continue
      }
      this.logger.info({ ip, data }, 'Got location for IP')
      return {
        city: data.city,
        country: data.country,
        region: data.region,
        latitude: (data.loc != null) ? parseFloat(data.loc.split(',')[0]) : undefined,
        longitude: (data.loc != null) ? parseFloat(data.loc.split(',')[1]) : undefined,
        orgName: data.org != null ? data.org.split(' ').slice(1).join(' ') : 'Unknown'
      }
    }
    return null
  }

  public async checkFromPR (pr: PullRequestReviewCommentCreatedEvent, criterias: Criteria[], otherAddress: string[] = [], retrievabilityThreshold?: number,
    retrievabilityRange?: number): Promise<[summary: string, content: string | undefined]> {
    const record = await this.getRecordByPR(pr.pull_request.id, pr.repository)
    const issue = await this.getIssueForRecord(record, pr.repository)
    return await this.check({ issue, repository: pr.repository }, criterias, otherAddress, retrievabilityThreshold, retrievabilityRange)
  }

  public async check (
    event: { issue: Issue, repository: Repository },
    criterias: Criteria[] = [
      {
        maxProviderDealPercentage: 0.25,
        maxDuplicationPercentage: 0.20,
        maxPercentageForLowReplica: 0.25,
        lowReplicaThreshold: 3
      }
    ],
    otherAddresses: string[] = [],
    retrievabilityThreshold: number = 0.2,
    retrievabilityRange: number = 7
  ): Promise<[summary: string, content: string | undefined]> {
    const { issue, repository } = event
    let logger = this.logger.child({ issueNumber: issue.number })
    logger.info('Checking issue')
    const address = this.getClientAddress(issue)
    if (address == null) {
      return [CidChecker.getErrorContent('No client address found for this issue.'), undefined]
    }
    const applicationInfo = await this.findApplicationInfoForClient(address)
    if (applicationInfo == null) {
      return [CidChecker.getErrorContent('No application info found for this issue on https://datacapstats.io/clients.'), undefined]
    }
    logger = logger.child({ clientAddress: applicationInfo.clientAddress })
    logger.info(applicationInfo, 'Retrieved application info')
    const allocations = applicationInfo.numberOfAllocations;
    const isEarlyAllocation = criterias.length > allocations
    if (allocations === 0) {
      return [CidChecker.getErrorContent('There is no previous allocation for this issue.'), undefined]
    }

    const addressGroup = otherAddresses
    if (!addressGroup.includes(applicationInfo.clientAddress)) {
      addressGroup.push(applicationInfo.clientAddress)
    }
    logger.info({ groups: addressGroup }, 'Retrieved address groups')

    const clientIds = await this.getClientAddressId(addressGroup)
    if (clientIds == null) {
      return [CidChecker.getErrorContent('No client ID found for this issue.'), undefined]
    }

    const criteria = criterias.length > allocations - 1 ? criterias[allocations - 1] : criterias[criterias.length - 1]

    // const shortIDs = await this.getClientShortIDs(addressGroup)
    const [providerDistributions, replicationDistributions, cidSharing] =
      await Promise.all([
        (async () => {
          const result = await this.getStorageProviderDistribution(clientIds)
          const providers = result.map(r => r.provider)
          if (providers.length === 0) {
            return []
          }
          const firstClientByProvider = await this.getFirstClientByProviders(providers)
          const withLocations: ProviderDistributionWithLocation[] = []
          for (const item of result) {
            const location = await this.getLocation(item.provider)
            const isNew = clientIds.includes(firstClientByProvider.find((row) => row.provider === item.provider)?.first_client ?? '')
            withLocations.push({ ...item, ...location, new: isNew })
          }
          return withLocations.sort((a, b) => a.orgName?.localeCompare(b.orgName ?? '') ?? 0)
        })(),
        this.getReplicationDistribution(clientIds),
        this.getCidSharing(clientIds)
      ])

    const { retrievability, avgProviderScore } = await this.providersRetrievability(providerDistributions, retrievabilityRange)

    if (providerDistributions.length === 0) {
      return [CidChecker.getErrorContent('No active deals found for this client.'), undefined]
    }

    const providerDistributionRows: ProviderDistributionRow[] = providerDistributions.map(distribution => {
      const totalDealSize = xbytes(parseFloat(distribution.total_deal_size), { iec: true })
      const uniqueDataSize = xbytes(parseFloat(distribution.unique_data_size), { iec: true })
      let location = [distribution.city, distribution.region, distribution.country].filter(x => x).join(', ')
      if (location === '' || location == null) {
        location = 'Unknown'
      }
      const orgName = distribution.orgName ?? 'Unknown'
      const matchedRetrievability = retrievability.find((item) => item.provider_id === distribution.provider)
      const retrievabilitySuccessRate =
        matchedRetrievability != null ? (matchedRetrievability.success_rate * 100).toFixed(2) + '%' : '-'

      return {
        provider: generateLink(distribution.provider, `https://filfox.info/en/address/${distribution.provider}`) + (distribution.new ? '`new` ' : ''),
        totalDealSize,
        uniqueDataSize,
        location: location + '<br/>' + wrapInCode(orgName),
        percentage: `${(distribution.percentage * 100).toFixed(2)}%`,
        duplicatePercentage: `${(distribution.duplication_percentage * 100).toFixed(2)}%`,
        retrievability: retrievabilitySuccessRate
      }
    })

    const replicationDistributionRows: ReplicationDistributionRow[] = replicationDistributions.map(distribution => {
      const totalDealSize = xbytes(parseFloat(distribution.total_deal_size), { iec: true })
      const uniqueDataSize = xbytes(parseFloat(distribution.unique_data_size), { iec: true })
      return {
        numOfReplica: distribution.num_of_replicas,
        totalDealSize,
        uniqueDataSize,
        percentage: `${(distribution.percentage * 100).toFixed(2)}%`
      }
    })

    const cidSharingRows: CidSharingRow[] = await Promise.all(
      cidSharing.map(
        async (share) => {
          const totalDealSize = xbytes(parseFloat(share.total_deal_size), { iec: true })
          const otherApplication = await this.findApplicationInfoForClient(share.other_client)
          return {
            otherClientAddress: CidChecker.linkifyAddress(share.other_client),
            totalDealSize,
            uniqueCidCount: share.unique_cid_count.toLocaleString('en-US'),
            otherClientOrganizationName: CidChecker.linkifyApplicationInfo(otherApplication),
            verifier: otherApplication?.issueNumber == null
              ? 'Unknown'
              : CidChecker.renderApprovers(await this.getApprovers(parseInt(otherApplication.issueNumber), repository))
          }
        }
      )
    )

    const providerDistributionImage = this.getImageForProviderDistribution(providerDistributions)
    const replicationDistributionImage = this.getImageForReplicationDistribution(replicationDistributions, criteria.lowReplicaThreshold)
    const providerDistributionImageUrl = (await this.uploadFile(
      `${repository.full_name}/issues/${issue.number}/${Date.now()}.png`,
      providerDistributionImage,
      `Upload provider distribution image for issue #${issue.number} of ${repository.full_name}`))[0]

    const replicationDistributionImageUrl = (await this.uploadFile(
      `${repository.full_name}/issues/${issue.number}/${Date.now()}.png`,
      replicationDistributionImage,
      `Upload replication distribution image for issue #${issue.number} of ${repository.full_name}`))[0]
    const clientId = (await this.getClientAddressId([applicationInfo.clientAddress])) ?? ['N/A']

    const content: string[] = []
    const summary: string[] = []
    const pushBoth = (str: string): void => {
      content.push(str)
      summary.push(str)
    }
    const now = new Date();
    content.push(`## DataCap and CID Checker Report[^1] (${now.toISOString().replace('T', ' ')})`)
    summary.push('## DataCap and CID Checker Report Summary[^1]')
    content.push(` - Allocator: ${wrapInCode(applicationInfo.verifier)}`)
    content.push(` - Organization: ${wrapInCode(applicationInfo.organizationName)}`)
    content.push(` - Client: ${wrapInCode(applicationInfo.clientAddress)}`)
    content.push(` - Client ID: ${wrapInCode(clientId[0] ?? 'N/A')}`)
    content.push(` - Github Issue: [#${applicationInfo.issueNumber ?? 'N/A'}](${applicationInfo.url})`)
    content.push('### Approvers')
    content.push(CidChecker.renderApprovers(await this.getApprovers(issue.number, repository)))
    content.push('')
    if (addressGroup.length > 1) {
      pushBoth('### Other Addresses[^2]')
      for (const address of addressGroup) {
        if (address !== applicationInfo.clientAddress) {
          const otherApplication = await this.findApplicationInfoForClient(address)
          pushBoth(` - ${CidChecker.linkifyAddress(address)} - ${CidChecker.linkifyApplicationInfo(otherApplication)}`)
          pushBoth('')
        }
      }
    }
    content.push('')
    pushBoth('### Storage Provider Distribution')
    content.push('The below table shows the distribution of storage providers that have stored data for this client.')
    content.push('')
    content.push('If this is the first time a provider takes verified deal, it will be marked as `new`.')
    content.push('')
    content.push('For most of the datacap application, below restrictions should apply.')
    if (isEarlyAllocation) {
      content.push('')
      content.push(`**Since this is the ${ordinal(allocations + 1)} allocation, the following restrictions have been relaxed:**`)
    }
    content.push(` - Storage provider should not exceed ${(criteria.maxProviderDealPercentage * 100).toFixed(0)}% of total datacap.`)
    content.push(` - Storage provider should not be storing duplicate data for more than ${(criteria.maxDuplicationPercentage * 100).toFixed(0)}%.`)
    content.push(' - Storage provider should have published its public IP address.')
    content.push(' - All storage providers should be located in different regions.')
    content.push('')
    let providerDistributionHealthy = true
    const providersExceedingMaxPercentage: Array<[string, number]> = []
    const providersExceedingMaxDuplication: Array<[string, number]> = []
    const providersNoIp: string[] = []
    for (const provider of providerDistributions) {
      const providerLink = generateLink(provider.provider, `https://filfox.info/en/address/${provider.provider}`)
      if (provider.percentage > criteria.maxProviderDealPercentage) {
        logger.info({ provider: provider.provider, percentage: provider.percentage }, 'Provider exceeds max percentage')
        content.push(emoji.get('warning') + ` ${providerLink} has sealed ${(provider.percentage * 100).toFixed(2)}% of total datacap.`)
        content.push('')
        providersExceedingMaxPercentage.push([provider.provider, provider.percentage])
        providerDistributionHealthy = false
      }
      if (provider.duplication_percentage > criteria.maxDuplicationPercentage) {
        logger.info({
          provider: provider.provider,
          duplicationFactor: provider.duplication_percentage
        }, 'Provider exceeds max duplication percentage')
        content.push(emoji.get('warning') + ` ${(provider.duplication_percentage * 100).toFixed(2)}% of total deal sealed by ${providerLink} are duplicate data.`)
        content.push('')
        providersExceedingMaxDuplication.push([provider.provider, provider.duplication_percentage])
        providerDistributionHealthy = false
      }
      if (provider.country == null || provider.country === '') {
        logger.info({ provider: provider.provider }, 'Provider does not have IP location')
        content.push(emoji.get('warning') + ` ${providerLink} has unknown IP location.`)
        content.push('')
        providersNoIp.push(provider.provider)
        providerDistributionHealthy = false
      }
    }
    if (providersExceedingMaxPercentage.length > 0) {
      summary.push(emoji.get('warning') + ` ${providersExceedingMaxPercentage.length} storage providers sealed more than ${(criteria.maxProviderDealPercentage * 100).toFixed(0)}% of total datacap - ` +
        providersExceedingMaxPercentage.map(([provider, percentage]) => ` ${generateLink(provider, `https://filfox.info/en/address/${provider}`)}: ${(percentage * 100).toFixed(2)}%`).join(', '))
      summary.push('')
    }
    if (providersExceedingMaxDuplication.length > 0) {
      summary.push(emoji.get('warning') + ` ${providersExceedingMaxDuplication.length} storage providers sealed too much duplicate data - ` +
        providersExceedingMaxDuplication.map(([provider, percentage]) => ` ${generateLink(provider, `https://filfox.info/en/address/${provider}`)}: ${(percentage * 100).toFixed(2)}%`).join(', '))
      summary.push('')
    }
    if (providersNoIp.length > 0) {
      summary.push(emoji.get('warning') + ` ${providersNoIp.length} storage providers have unknown IP location - ` +
        providersNoIp.map(provider => ` ${generateLink(provider, `https://filfox.info/en/address/${provider}`)}`).join(', '))
      summary.push('')
    }
    if (new Set(providerDistributionRows.map(row => row.location)).size <= 1) {
      logger.info('Client has data stored in only one region')
      pushBoth(emoji.get('warning') + ' All storage providers are located in the same region.')
      pushBoth('')
      providerDistributionHealthy = false
    }

    if (providerDistributionHealthy) {
      pushBoth(emoji.get('heavy_check_mark') + ' Storage provider distribution looks healthy.')
      pushBoth('')
    }

    const countWarningRetrievability = retrievability.filter((item) => item.success_rate === 0).length
    const WarningRetriveabilityPercentage = (countWarningRetrievability / retrievability.length) * 100
    if (countWarningRetrievability > 0) {
      pushBoth(
        emoji.get('warning') +
          ` ${WarningRetriveabilityPercentage.toFixed(2)}% of Storage Providers have retrieval success rate equal to zero.`
      )
      pushBoth('')
    }

    const retrievabilityThreeQuart = retrievability.filter((item) => item.success_rate < 0.75).length
    if ((retrievability.length > 0) && retrievabilityThreeQuart > 0) {
      const warningThreeQuart = (retrievabilityThreeQuart / retrievability.length) * 100
      pushBoth(emoji.get('warning') + ` ${warningThreeQuart.toFixed(2)}% of Storage Providers have retrieval success rate less than 75%.`)
      pushBoth('')
    }

    if ((retrievability.length > 0) && avgProviderScore < retrievabilityThreshold) {
      pushBoth(emoji.get('warning') + ` The average retrieval success rate is ${(avgProviderScore * 100).toFixed(2)}%`)
      pushBoth('')
    }

    content.push(generateGfmTable(providerDistributionRows,
      [
        ['provider', { name: 'Provider', align: 'l' }],
        ['location', { name: 'Location', align: 'r' }],
        ['totalDealSize', { name: 'Total Deals Sealed', align: 'r' }],
        ['percentage', { name: 'Percentage', align: 'r' }],
        ['uniqueDataSize', { name: 'Unique Data', align: 'r' }],
        ['duplicatePercentage', { name: 'Duplicate Deals', align: 'r' }],
        ['retrievability', { name: `Mean Spark Retrieval Success Rate ${retrievabilityRange}d`, align: 'r' }]
      ])
    )
    pushBoth('')
    content.push(`<img src="${providerDistributionImageUrl}"/>`)
    content.push('')

    pushBoth('### Deal Data Replication')
    content.push('The below table shows how each many unique data are replicated across storage providers.')
    content.push('')
    if (criteria.maxPercentageForLowReplica < 1) {
      if (isEarlyAllocation) {
        content.push('')
        content.push(`**Since this is the ${ordinal(allocations + 1)} allocation, the following restrictions have been relaxed:**`)
      }
      content.push(`- No more than ${(criteria.maxPercentageForLowReplica * 100).toFixed(0)}% of unique data are stored with less than ${criteria.lowReplicaThreshold + 1} providers.`)
    }
    content.push('')
    const lowReplicaPercentage = replicationDistributions
      .filter(distribution => distribution.num_of_replicas <= criteria.lowReplicaThreshold)
      .map(distribution => distribution.percentage)
      .reduce((a, b) => a + b, 0)
    if (lowReplicaPercentage > criteria.maxPercentageForLowReplica) {
      logger.info({ lowReplicaPercentage }, 'Low replica percentage exceeds max percentage')
      pushBoth(emoji.get('warning') + ` ${(lowReplicaPercentage * 100).toFixed(2)}% of deals are for data replicated across less than ${criteria.lowReplicaThreshold + 1} storage providers.`)
      pushBoth('')
    } else {
      pushBoth(emoji.get('heavy_check_mark') + ' Data replication looks healthy.')
      pushBoth('')
    }
    content.push(generateGfmTable(replicationDistributionRows, [
      ['uniqueDataSize', { name: 'Unique Data Size', align: 'r' }],
      ['totalDealSize', { name: 'Total Deals Made', align: 'r' }],
      ['numOfReplica', { name: 'Number of Providers', align: 'r' }],
      ['percentage', { name: 'Deal Percentage', align: 'r' }]
    ]))
    content.push('')

    content.push(`<img src="${replicationDistributionImageUrl}"/>`)
    pushBoth('')
    pushBoth('### Deal Data Shared with other Clients[^3]')
    content.push('The below table shows how many unique data are shared with other clients.')
    content.push('Usually different applications owns different data and should not resolve to the same CID.')
    content.push('')
    content.push('However, this could be possible if all below clients use same software to prepare for the exact same dataset or they belong to a series of LDN applications for the same dataset.')
    content.push('')
    if (cidSharingRows.length > 0) {
      for (const row of cidSharingRows) {
        logger.info({ otherClientAddress: row.otherClientAddress }, 'CID is shared with another client')
      }
      content.push(emoji.get('warning') + ' CID sharing has been observed.')
      summary.push(emoji.get('warning') + ' CID sharing has been observed. (Top 3)')
      pushBoth('')
      content.push(generateGfmTable(cidSharingRows, [
        ['otherClientAddress', { name: 'Other Client', align: 'l' }],
        ['otherClientOrganizationName', { name: 'Application', align: 'l' }],
        ['totalDealSize', { name: 'Total Deals Affected', align: 'r' }],
        ['uniqueCidCount', { name: 'Unique CIDs', align: 'r' }],
        ['verifier', { name: 'Approvers', align: 'l' }]
      ]))
      for (const row of cidSharingRows.slice(0, 3)) {
        summary.push(`- ${row.totalDealSize} - ${row.otherClientAddress} - ${row.otherClientOrganizationName}`)
      }
    } else {
      pushBoth(emoji.get('heavy_check_mark') + ' No CID sharing has been observed.')
    }

    pushBoth('')
    pushBoth('[^1]: To manually trigger this report, add a comment with text `checker:manualTrigger`')
    pushBoth('')
    pushBoth('[^2]: Deals from those addresses are combined into this report as they are specified with `checker:manualTrigger`')
    pushBoth('')
    pushBoth('[^3]: To manually trigger this report with deals from other related addresses, add a comment with text `checker:manualTrigger <other_address_1> <other_address_2> ...`')
    pushBoth('')
    const joinedContent = content.join('\n')
    const contentUrl = await this.uploadReport(joinedContent, event)

    try {
      await this.sql.query(
        'INSERT INTO generated_reports (client_address_id, file_path) VALUES ($1, $2)',
        [applicationInfo.clientAddress, contentUrl]
      )
    } catch (e) {
      logger.error({ error: e }, 'Failed to insert generated report into database')
    }

    summary.push('### Full report')
    summary.push(`Click ${generateLink('here', contentUrl)} to view the CID Checker report.`)
    return [summary.join('\n'), joinedContent]
  }

  public async getAllClientGeneratedReports (address: string){
    const applicationInfo = await this.findApplicationInfoForClient(address)
    if (applicationInfo == null) {
      return [CidChecker.getErrorContent('No application info found for this issue on https://datacapstats.io/clients.'), undefined]
    }

    const queryResult = await this.sql.query(
      CidChecker.AllGeneratedReportsQuery,
      [applicationInfo.clientAddress]);

    return queryResult.rows
  }

  public async getLatestClientGeneratedReport (address: string){
    const applicationInfo = await this.findApplicationInfoForClient(address)
    if (applicationInfo == null) {
      return [CidChecker.getErrorContent('No application info found for this issue on https://datacapstats.io/clients.'), undefined]
    }

    const queryResult = await retry(async () => await this.sql.query(
      CidChecker.LatestGeneratedReportQuery,
      [applicationInfo.clientAddress]), { retries: 3 })

    const rows: Array<{ file_path: string }> = queryResult.rows

    return rows[0]?.file_path
  }

  private async providersRetrievability (
    providerDistributions: ProviderDistributionWithLocation[],
    retrievabilityRange: number
  ): Promise<{ retrievability: Retrievability[], avgProviderScore: number }> {
    try {
      const from = new Date(Date.now() - retrievabilityRange * 24 * 3600 * 1000).toISOString().split('T')[0]
      const to = new Date().toISOString().split('T')[0]

      const sparkData = await this.fetchRetrievalSuccessRate(from, to)

      const retrievability = this.createRetrievability(providerDistributions, sparkData)
      if (retrievability.length === 0) return { retrievability: [], avgProviderScore: 0 }

      const avgProviderScore = this.calculateAvgProviderScore(retrievability)

      return { retrievability, avgProviderScore }
    } catch (error) {
      console.error('Failed to fetch retrievability data:', error)
      return { retrievability: [], avgProviderScore: 0 }
    }
  }

  private calculateAvgProviderScore (matchedRetrievability: Retrievability[]): number {
    const { totalClientDealSize, totalSuccessRate } = matchedRetrievability.reduce(
      (acc, { total_deal_size, success_rate }) => {
        acc.totalClientDealSize += total_deal_size
        acc.totalSuccessRate += success_rate * total_deal_size
        return acc
      },
      { totalClientDealSize: 0, totalSuccessRate: 0 }
    )

    if (totalSuccessRate === 0 || totalClientDealSize === 0) return 0
    return totalSuccessRate / totalClientDealSize
  }

  private createRetrievability (
    providerDistributions: ProviderDistributionWithLocation[],
    sparkData: SparkSuccessRate[]
  ): Retrievability[] {
    const retrievability = providerDistributions
      .map(({ provider, total_deal_size }) => {
        const sparkItem = sparkData.find((x) => x.miner_id === provider)

        if (sparkItem == null) return null

        return {
          provider_id: sparkItem.miner_id,
          success_rate: sparkItem.success_rate,
          total_deal_size: Number(total_deal_size)
        }
      }).filter(isNotEmpty)

    return retrievability
  }

  private async fetchRetrievalSuccessRate (from: string, to: string): Promise<SparkSuccessRate[]> {
    const response = await axios.get(`https://stats.filspark.com/miners/retrieval-success-rate/summary?from=${from}&to=${to}`)
    const sparkData: SparkSuccessRate[] = response.data

    return sparkData
  }

  private async uploadReport (joinedContent: string, event: { issue: Issue, repository: Repository }): Promise<string> {
    const { issue, repository } = event
    const logger = this.logger.child({ issueNumber: issue.number })
    const contentUrl = await this.uploadFile(
      `${repository.full_name}/issues/${issue.number}/${Date.now()}.md`,
      Buffer.from(joinedContent).toString('base64'),
      `Upload report for issue #${issue.number} of ${repository.full_name}`)
    logger.info({ contentUrl: contentUrl[1] }, 'Report content uploaded')
    return contentUrl[1]
  }

  private async getClientAddressId (clientAddress: string[]): Promise<string[] | null> {
    try {
      const clientIds: string[] = []
      for (const address of clientAddress) {
        await retry(async () => {
          const response = await axios.post('https://api.node.glif.io/rpc/v0', {
            jsonrpc: '2.0',
            id: 1,
            method: 'Filecoin.StateLookupID',
            params: [
              address, null
            ]
          })
          const result = response.data.result
          if (result === undefined) {
            throw new Error('Invalid glif response while getting client id')
          }
          clientIds.push(result)
        }, { retries: 3 })
      }
      return clientIds
    } catch (e) {
      console.error(e)
      return null
    }
  }
}
