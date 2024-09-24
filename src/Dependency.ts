import { Pool } from 'pg'
import { Logger } from 'pino'
import CidChecker, { FileUploadConfig } from './checker/CidChecker'
import { Octokit } from '@octokit/core'

export const pool = new Pool({
  connectionString:
    process.env.PG_CONNECTION_STRING
})


export function getCidChecker (logger: Logger, octo?: Octokit): CidChecker {
  if (process.env.UPLOAD_REPO_OWNER === undefined ||
    process.env.UPLOAD_REPO_NAME === undefined ||
    process.env.UPLOAD_REPO_COMMITTER_NAME === undefined ||
  //    process.env.UPLOAD_TOKEN === undefined ||
    process.env.IPINFO_TOKEN === undefined ||
    process.env.UPLOAD_REPO_COMMITTER_EMAIL === undefined) {
    throw new Error('IPINFO_TOKEN, UPLOAD_TOKEN, UPLOAD_REPO_OWNER, UPLOAD_REPO_NAME, UPLOAD_REPO_COMMITTER_NAME, UPLOAD_REPO_COMMITTER_EMAIL must be defined')
  }

  const fileUploadConfig: FileUploadConfig = {
    local: process.env.UPLOAD_DIR,
    localBaseURL: process.env.UPLOAD_BASE_URL || '',
    owner: process.env.UPLOAD_REPO_OWNER,
    repo: process.env.UPLOAD_REPO_NAME,
    branch: process.env.UPLOAD_REPO_BRANCH,
    committerName: process.env.UPLOAD_REPO_COMMITTER_NAME,
    committerEmail: process.env.UPLOAD_REPO_COMMITTER_EMAIL
  }

  if (octo === undefined) {
    const octokit = new Octokit({
      //    auth: process.env.UPLOAD_TOKEN,
      appId: parseInt(process.env.APP_ID ?? '0'),
      privateKey: process.env.PRIVATE_KEY,
      log: logger
    })
    octo = octokit
  }

  return new CidChecker(
    pool,
    octo,
    fileUploadConfig,
    logger,
    process.env.IPINFO_TOKEN
  )
}
