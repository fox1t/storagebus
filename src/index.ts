import Metadata, { MetadataObject } from './lib/metadata'
import FSStorage from './storage/fs'
import GCSStorage from './storage/gcs'
import S3Storage from './storage/s3'
import AZBlobStorage from './storage/azure-blob'
import { Readable } from 'stream'
import createDb, { Db } from './db'

function getPrefix(seconds: number) {
  return Math.max(Math.floor(seconds / 86400), 1)
}

export interface StorageConfig {
  env: string
  expireSeconds?: number

  storageType: 's3' | 'gcs' | 'az' | 'fs'
  storageUri: string
  storageUser?: string
  storageKey?: string

  databaseType?: 'redis' | 'mongodb'
  databaseHost: string
  databaseCollection?: string
}

class Storage {
  storage: FSStorage | GCSStorage | S3Storage | AZBlobStorage
  expireSeconds: number
  db: Db

  constructor(config: StorageConfig) {
    if (!config.storageUri) {
      throw new Error(`"Storage URI" property is mandatory.`)
    }
    let StorageDriver
    if (config.storageType === 's3') {
      StorageDriver = require('./storage/s3').default as S3Storage
    } else if (config.storageType === 'gcs') {
      StorageDriver = require('./storage/gcs').default as GCSStorage
    } else if (config.storageType === 'az') {
      StorageDriver = require('./storage/azure-blob').default as AZBlobStorage
    } else {
      StorageDriver = require('./storage/fs').default as FSStorage
    }

    this.storage = new StorageDriver(config.storageUri, config.storageUser, config.storageKey)

    this.db = createDb({
      databaseType: config.databaseType,
      host: config.databaseHost,
      collection: config.databaseCollection,
      env: config.env,
    })

    this.expireSeconds = config.expireSeconds || 0
  }

  async ttl(id: string) {
    const result = await this.db.ttl(id)
    return Math.ceil(result) * 1000
  }

  async getPrefixedId(id: string) {
    const prefix = await this.db.get(id, 'prefix')
    return `${prefix}-${id}`
  }

  async length(id: string) {
    const filePath = await this.getPrefixedId(id)
    return this.storage.length(filePath)
  }

  async get(id: string) {
    const filePath = await this.getPrefixedId(id)
    return this.storage.getStream(filePath)
  }

  async set(id: string, file: Readable, meta?: any, expireSeconds: number = this.expireSeconds) {
    const prefix = getPrefix(expireSeconds)
    const filePath = `${prefix}-${id}`
    await this.db.set(id, 'prefix', prefix.toString())
    if (!file.readable) {
      throw new Error('Passed stream is not readable.')
    }
    await this.storage.set(filePath, file)
    if (meta) {
      await this.db.set(id, meta)
    }
    await this.db.expire(id, expireSeconds)
  }

  setField(id: string, key: string, value: string) {
    this.db.set(id, key, value)
  }

  async del(id: string) {
    const filePath = await this.getPrefixedId(id)
    await this.storage.del(filePath)
    await this.db.del(id)
  }

  async ping() {
    await this.db.ping()
    await this.storage.ping()
  }

  async metadata(id: string) {
    const result = (await this.db.get(id)) as MetadataObject
    return result && new Metadata(result)
  }

  async close() {
    this.db.close()
  }
}

export default (config: StorageConfig) => new Storage(config)
