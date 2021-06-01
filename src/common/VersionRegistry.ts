// accessor class for the on-chain version registry
import versionRegistryAbi from '../common/interfaces/IVersionRegistry.json'
import { PrefixedHexString } from '../relayclient/types/Aliases'
import { ethers } from 'hardhat'
import { providers } from 'ethers'
import { VersionRegistry } from '../../typechain'

export function string32 (s: string): PrefixedHexString {
  return ethers.utils.hexlify(Buffer.from(s)).padEnd(66,'0')
}

// convert a bytes32 into a string, removing any trailing zeros
export function bytes32toString (s: PrefixedHexString): string {
  return Buffer.from(s.replace(/^(?:0x)?(.*?)(00)*$/, '$1'), 'hex').toString()
}

export interface VersionInfo {
  value: string
  version: string
  time: number
  canceled: boolean
  cancelReason: string
}

export interface SendOptions {
  gasPrice?: string
  gasLimit?: string
}

export class VersionRegistryInteractor {
  registryContract: VersionRegistry
  provider: providers.JsonRpcProvider

  constructor (provider: providers.JsonRpcProvider, registryAddress: PrefixedHexString) {
    this.provider = provider
    this.registryContract = new ethers.Contract(registryAddress, versionRegistryAbi, this.provider) as VersionRegistry
  }

  async isValid (): Promise<boolean> {
    // validate the contract exists, and has the registry API
    // Check added for RSKJ: when the contract does not exist in RSKJ it replies to the getCode call with 0x00
    const code = await this.provider.getCode(this.registryContract.address)
    if (code === '0x' || code === '0x00') { return false }
    // this check return 'true' only for owner
    // return this.registryContract.methods.addVersion('0x414243', '0x313233', '0x313233').estimateGas(this.sendOptions)
    //   .then(() => true)
    //   .catch(() => false)
    return true
  }

  /**
   * return the latest "mature" version from the registry
   *
   * @dev: current time is last block's timestamp. This resolves any client time-zone discrepancies,
   *  but on local ganache, note that the time doesn't advance unless you mine transactions.
   *
   * @param id object id to return a version for
   * @param delayPeriod - don't return entries younger than that (in seconds)
   * @param optInVersion - if set, return this version even if it is young
   * @return version info that include actual version used, its timestamp and value.
   */
  async getVersion (id: string, delayPeriod: number, optInVersion = ''): Promise<VersionInfo> {
    const [versions, now] = await Promise.all([
      this.getAllVersions(id),
      this.provider.getBlock('latest').then(b => b.timestamp as number)
    ])

    const ver = versions
      .find((v: { canceled: any; time: number; version: string }) => !v.canceled && (v.time + delayPeriod <= now || v.version === optInVersion))
    if (ver == null) {
      throw new Error(`getVersion(${id}) - no version found`)
    }

    return ver
  }

  /**
   * return all version history of the given id
   * @param id object id to return version history for
   */
  async getAllVersions (id: string): Promise<any> {
    const cancelEvent =  this.registryContract.filters.VersionCanceled(string32(id), null, null)
    const cancelEventsEmitted = await this.registryContract.queryFilter(cancelEvent, 1)
    // const events = await this.registryContract.getPastEvents('allEvents', { fromBlock: 1, topics: [null, string32(id)] })
    // map of ver=>reason, for every canceled version
    const cancelReasons: { [key: string]: string } = cancelEventsEmitted.reduce((set, e) => ({
      ...set,
      [e.args?.version]: e.args?.reason
    }), {})

    const found = new Set<string>()
    const versionAddedEvent =  this.registryContract.filters.VersionAdded(string32(id), null, null, null)
    const versionAddedEventsEmitted = await this.registryContract.queryFilter(versionAddedEvent, 1)
    
    return versionAddedEventsEmitted
      .map(e => ({
        version: bytes32toString(e.args?.version),
        canceled: cancelReasons[e.args?.version] != null,
        cancelReason: cancelReasons[e.args?.version],
        value: e.args?.value,
        time: parseInt(e.args?.time.toString())
      }))
      .filter(e => {
        // use only the first occurrence of each version
        if (found.has(e.version)) {
          return false
        } else {
          found.add(e.version)
          return true
        }
      })
      .reverse()
  }

  // return all IDs registered
  async listIds (): Promise<string[]> {
    const versionAddedEvent =  this.registryContract.filters.VersionAdded(null, null, null, null)
    const versionAddedEventsEmitted = await this.registryContract.queryFilter(versionAddedEvent, 1)
    // const events = await this.registryContract.getPastEvents('VersionAdded', { fromBlock: 1 })
    const ids = new Set(versionAddedEventsEmitted.map(e => bytes32toString(e.args?.id)))
    return Array.from(ids)
  }

  async addVersion (id: string, version: string, value: string, sendOptions: SendOptions = {}, from?: string): Promise<void> {
    const fromSigner = await ethers.getSigner(from?? '')
    await this.checkVersion(id, version, false)
    await this.registryContract.connect(fromSigner).addVersion(string32(id), string32(version), value, sendOptions)
  }

  async cancelVersion (id: string, version: string, cancelReason = '', sendOptions: SendOptions = {}, from?: string): Promise<void> {
    const fromSigner = await ethers.getSigner(from?? '')
    await this.checkVersion(id, version, true)
    await this.registryContract.connect(fromSigner).cancelVersion(string32(id), string32(version), cancelReason, sendOptions)
  }

  private async checkVersion (id: string, version: string, validateExists: boolean): Promise<void> {
    const versions = await this.getAllVersions(id).catch(() => [])
    if ((versions.find((v: { version: string }) => v.version === version) != null) !== validateExists) {
      throw new Error(`version ${validateExists ? 'does not exist' : 'already exists'}: ${id} @ ${version}`)
    }
  }
}
