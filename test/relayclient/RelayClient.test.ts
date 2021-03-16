import Transaction from 'ethereumjs-tx/dist/transaction'
import Web3 from 'web3'
import chai from 'chai'
import sinon from 'sinon'
import sinonChai from 'sinon-chai'
import { ChildProcessWithoutNullStreams } from 'child_process'
import { HttpProvider } from 'web3-core'
import express from 'express'
import axios from 'axios'

import {
  RelayHubInstance,
  StakeManagerInstance,
  TestRecipientInstance,
  SmartWalletInstance, ProxyFactoryInstance, TestTokenInstance, TestVerifierEverythingAcceptedInstance, TestDeployVerifierEverythingAcceptedInstance
} from '../../types/truffle-contracts'

import { DeployRequest, RelayRequest } from '../../src/common/EIP712/RelayRequest'
import { _dumpRelayingResult, RelayClient } from '../../src/relayclient/RelayClient'
import { Address } from '../../src/relayclient/types/Aliases'
import { PrefixedHexString } from 'ethereumjs-tx'
import { configure, getDependencies, EnvelopingConfig } from '../../src/relayclient/Configurator'
import replaceErrors from '../../src/common/ErrorReplacerJSON'
import EnvelopingTransactionDetails from '../../src/relayclient/types/EnvelopingTransactionDetails'
// @ts-ignore
import { TypedDataUtils } from 'eth-sig-util'

import BadHttpClient from '../dummies/BadHttpClient'
import BadContractInteractor from '../dummies/BadContractInteractor'
import BadRelayedTransactionValidator from '../dummies/BadRelayedTransactionValidator'
import { deployHub, startRelay, stopRelay, getTestingEnvironment, createProxyFactory, createSmartWallet, getGaslessAccount, snapshot, revert } from '../TestUtils'
import { RelayInfo } from '../../src/relayclient/types/RelayInfo'
import PingResponse from '../../src/common/PingResponse'
import { RelayEvent } from '../../src/relayclient/RelayEvents'
import { Web3Provider } from '../../src/common/ContractInteractor'
import bodyParser from 'body-parser'
import { Server } from 'http'
import HttpClient from '../../src/relayclient/HttpClient'
import HttpWrapper from '../../src/relayclient/HttpWrapper'
import { RelayTransactionRequest } from '../../src/relayclient/types/RelayTransactionRequest'
import { AccountKeypair } from '../../src/relayclient/AccountManager'
import { soliditySha3Raw, toBN, toHex } from 'web3-utils'
import { constants } from '../../src/common/Constants'
import { DeployRequestDataType, getDomainSeparatorHash, TypedDeployRequestData } from '../../src/common/EIP712/TypedRequestData'
import { bufferToHex } from 'ethereumjs-util'
import { expectEvent, ether } from '@openzeppelin/test-helpers'

const StakeManager = artifacts.require('StakeManager')
const TestRecipient = artifacts.require('TestRecipient')
const TestRelayVerifier = artifacts.require('TestVerifierEverythingAccepted')
const TestDeployVerifier = artifacts.require('TestDeployVerifierEverythingAccepted')
const SmartWallet = artifacts.require('SmartWallet')
const TestToken = artifacts.require('TestToken')
const expect = chai.expect
chai.use(sinonChai)

const localhostOne = 'http://localhost:8090'
const cheapRelayerUrl = 'http://localhost:54321'
const underlyingProvider = web3.currentProvider as HttpProvider

class MockHttpClient extends HttpClient {
  constructor (readonly mockPort: number,
    httpWrapper: HttpWrapper, config: Partial<EnvelopingConfig>) {
    super(httpWrapper, config)
  }

  async relayTransaction (relayUrl: string, request: RelayTransactionRequest): Promise<PrefixedHexString> {
    return await super.relayTransaction(this.mapUrl(relayUrl), request)
  }

  private mapUrl (relayUrl: string): string {
    return relayUrl.replace(':8090', `:${this.mockPort}`)
  }
}

contract('RelayClient', function (accounts) {
  let web3: Web3
  let relayHub: RelayHubInstance
  let stakeManager: StakeManagerInstance
  let testRecipient: TestRecipientInstance
  let relayVerifier: TestVerifierEverythingAcceptedInstance
  let deployVerifier: TestDeployVerifierEverythingAcceptedInstance
  let relayProcess: ChildProcessWithoutNullStreams
  let relayClient: RelayClient
  let config: Partial<EnvelopingConfig>
  let options: EnvelopingTransactionDetails
  let to: Address
  let from: Address
  let data: PrefixedHexString
  let relayEvents: RelayEvent[] = []
  let factory: ProxyFactoryInstance
  let sWalletTemplate: SmartWalletInstance
  let smartWallet: SmartWalletInstance
  let token: TestTokenInstance
  let gaslessAccount: AccountKeypair

  async function registerRelayer (relayHub: RelayHubInstance): Promise<void> {
    const relayWorker = '0x'.padEnd(42, '2')
    const relayOwner = accounts[3]
    const relayManager = accounts[4]
    await stakeManager.stakeForAddress(relayManager, 1000, {
      value: ether('2'),
      from: relayOwner
    })
    await stakeManager.authorizeHubByOwner(relayManager, relayHub.address, { from: relayOwner })

    await relayHub.addRelayWorkers([relayWorker], { from: relayManager })
    await relayHub.registerRelayServer(1, 1, cheapRelayerUrl, { from: relayManager })
  }

  before(async function () {
    web3 = new Web3(underlyingProvider)
    stakeManager = await StakeManager.new(0)
    relayHub = await deployHub(stakeManager.address)
    testRecipient = await TestRecipient.new()
    sWalletTemplate = await SmartWallet.new()
    token = await TestToken.new()
    const env = (await getTestingEnvironment())
    gaslessAccount = await getGaslessAccount()
    factory = await createProxyFactory(sWalletTemplate)
    smartWallet = await createSmartWallet(accounts[0], gaslessAccount.address, factory, gaslessAccount.privateKey, env.chainId)
    relayVerifier = await TestRelayVerifier.new()
    deployVerifier = await TestDeployVerifier.new()

    relayProcess = (await startRelay(relayHub.address, stakeManager, {
      stake: 1e18,
      relayOwner: accounts[1],
      rskNodeUrl: underlyingProvider.host,
      deployVerifierAddress: deployVerifier.address,
      relayVerifierAddress: relayVerifier.address,
      workerTargetBalance: 0.6e18
    })).proc

    config = {
      logLevel: 5,
      relayHubAddress: relayHub.address,
      chainId: env.chainId,
      deployVerifierAddress: deployVerifier.address,
      relayVerifierAddress: relayVerifier.address
    }

    relayClient = new RelayClient(underlyingProvider, config)

    // register gasless account in RelayClient to avoid signing with RSKJ
    relayClient.accountManager.addAccount(gaslessAccount)

    from = gaslessAccount.address
    to = testRecipient.address
    await token.mint('1000', smartWallet.address)

    data = testRecipient.contract.methods.emitMessage('hello world').encodeABI()

    options = {
      from,
      to,
      data,
      relayHub: relayHub.address,
      callForwarder: smartWallet.address,
      callVerifier: relayVerifier.address,
      clientId: '1',
      tokenContract: token.address,
      tokenAmount: '1',
      tokenGas: '50000',
      isSmartWalletDeploy: false
    }
  })

  after(async function () {
    await stopRelay(relayProcess)
  })

  describe('#relayTransaction()', function () {
    it('should send transaction to a relay and receive a signed transaction in response', async function () {
      const relayingResult = await relayClient.relayTransaction(options)
      const validTransaction = relayingResult.transaction

      if (validTransaction == null) {
        assert.fail(`validTransaction is null: ${JSON.stringify(relayingResult, replaceErrors)}`)
        return
      }
      const validTransactionHash: string = validTransaction.hash(true).toString('hex')
      const txHash = `0x${validTransactionHash}`
      const res = await web3.eth.getTransactionReceipt(txHash)

      // validate we've got the "SampleRecipientEmitted" event
      // TODO: use OZ test helpers
      const topic: string = web3.utils.sha3('SampleRecipientEmitted(string,address,address,uint256,uint256)') ?? ''
      assert(res.logs.find(log => log.topics.includes(topic)))

      const destination: string = validTransaction.to.toString('hex')
      assert.equal(`0x${destination}`, relayHub.address.toString().toLowerCase())
    })

    it('should skip timed-out server', async function () {
      let server: Server | undefined
      try {
        const pingResponse = await axios.get('http://localhost:8090/getaddr').then(res => res.data)
        const mockServer = express()
        mockServer.use(bodyParser.urlencoded({ extended: false }))
        mockServer.use(bodyParser.json())

        mockServer.get('/getaddr', async (req, res) => {
          console.log('=== got GET ping', req.query)
          res.send(pingResponse)
        })
        mockServer.post('/relay', () => {
          console.log('== got relay.. ignoring')
          // don't answer... keeping client in limbo
        })

        await new Promise((resolve) => {
          server = mockServer.listen(0, resolve)
        })
        const mockServerPort = (server as any).address().port

        // MockHttpClient alter the server port, so the client "thinks" it works with relayUrl, but actually
        // it uses the mockServer's port
        const relayClient = new RelayClient(underlyingProvider, config, {
          httpClient: new MockHttpClient(mockServerPort, new HttpWrapper({ timeout: 100 }), config)
        })

        // register gasless account in RelayClient to avoid signing with RSKJ
        relayClient.accountManager.addAccount(gaslessAccount)

        // async relayTransaction (relayUrl: string, request: RelayTransactionRequest): Promise<PrefixedHexString> {
        const relayingResult = await relayClient.relayTransaction(options)
        assert.match(_dumpRelayingResult(relayingResult), /timeout.*exceeded/)
      } finally {
        server?.close()
      }
    })

    it('should use forceGasPrice if provided', async function () {
      const forceGasPrice = '0x777777777'
      const optionsForceGas = Object.assign({}, options, { forceGasPrice })
      const { transaction, pingErrors, relayingErrors } = await relayClient.relayTransaction(optionsForceGas)
      assert.equal(pingErrors.size, 0)
      assert.equal(relayingErrors.size, 0)
      assert.equal(parseInt(transaction!.gasPrice.toString('hex'), 16), parseInt(forceGasPrice))
    })

    it('should return errors encountered in ping', async function () {
      const badHttpClient = new BadHttpClient(configure(config), true, false, false)
      const relayClient =
        new RelayClient(underlyingProvider, config, { httpClient: badHttpClient })
      const { transaction, relayingErrors, pingErrors } = await relayClient.relayTransaction(options)
      assert.isUndefined(transaction)
      assert.equal(relayingErrors.size, 0)
      assert.equal(pingErrors.size, 1)
      assert.equal(pingErrors.get(localhostOne)!.message, BadHttpClient.message)
    })

    it('should return errors encountered in relaying', async function () {
      const badHttpClient = new BadHttpClient(configure(config), false, true, false)
      const relayClient =
        new RelayClient(underlyingProvider, config, { httpClient: badHttpClient })

      // register gasless account in RelayClient to avoid signing with RSKJ
      relayClient.accountManager.addAccount(gaslessAccount)

      const { transaction, relayingErrors, pingErrors } = await relayClient.relayTransaction(options)
      assert.isUndefined(transaction)
      assert.equal(pingErrors.size, 0)
      assert.equal(relayingErrors.size, 1)
      assert.equal(relayingErrors.get(localhostOne)!.message, BadHttpClient.message)
    })

    it('should return errors in callback (asyncApprovalData) ', async function () {
      const relayClient =
        new RelayClient(underlyingProvider, config, {
          asyncApprovalData: async () => { throw new Error('approval-error') }
        })

      // register gasless account in RelayClient to avoid signing with RSKJ
      relayClient.accountManager.addAccount(gaslessAccount)

      const { transaction, relayingErrors, pingErrors } = await relayClient.relayTransaction(options)
      assert.isUndefined(transaction)
      assert.equal(pingErrors.size, 0)
      assert.equal(relayingErrors.size, 1)
      assert.match(relayingErrors.values().next().value.message, /approval-error/)
    })

    it('should return errors in callback (asyncVerifierData) ', async function () {
      const relayClient =
        new RelayClient(underlyingProvider, config, {
          asyncApprovalData: async () => { throw new Error('verifierData-error') }
        })

      // register gasless account in RelayClient to avoid signing with RSKJ
      relayClient.accountManager.addAccount(gaslessAccount)
      const { transaction, relayingErrors, pingErrors } = await relayClient.relayTransaction(options)
      assert.isUndefined(transaction)
      assert.equal(pingErrors.size, 0)
      assert.equal(relayingErrors.size, 1)
      assert.match(relayingErrors.values().next().value.message, /verifierData-error/)
    })

    // TODO test other things, for example, if the smart wallet to deploy has no funds, etc
    // Do we want to restrict to certnain factories?

    it('should calculate the estimatedGas for deploying a SmartWallet using the ProxyFactory', async function () {
      const eoaWithoutSmartWalletAccount = await getGaslessAccount()
      // register eoaWithoutSmartWalletAccount account in RelayClient to avoid signing with RSKJ
      relayClient.accountManager.addAccount(eoaWithoutSmartWalletAccount)
      const swAddress = await factory.getSmartWalletAddress(eoaWithoutSmartWalletAccount.address, constants.ZERO_ADDRESS, constants.ZERO_ADDRESS, soliditySha3Raw({ t: 'bytes', v: '0x' }), '0')
      await token.mint('1000', swAddress)

      const details: EnvelopingTransactionDetails = {
        from: eoaWithoutSmartWalletAccount.address,
        to: constants.ZERO_ADDRESS, // No extra logic for the Smart Wallet
        data: '0x', // No extra-logic init data
        callForwarder: factory.address,
        callVerifier: deployVerifier.address,
        clientId: '1',
        tokenContract: token.address,
        tokenAmount: '1',
        tokenGas: '50000',
        recoverer: constants.ZERO_ADDRESS,
        index: '0',
        gasPrice: '0x1',
        gas: toHex('400000'),
        value: '0',
        isSmartWalletDeploy: true,
        useEnveloping: true,
        relayHub: accounts[0]
      }

      const estimatedGasResult = await relayClient.calculateSmartWalletDeployGas(details)
      const originalBalance = await token.balanceOf(swAddress)
      const senderNonce = await factory.nonce(eoaWithoutSmartWalletAccount.address)
      const chainId = (await getTestingEnvironment()).chainId

      const request: DeployRequest = {
        request: {
          relayHub: accounts[0],
          from: eoaWithoutSmartWalletAccount.address,
          to: constants.ZERO_ADDRESS,
          value: '0',
          gas: toHex('400000'),
          nonce: senderNonce.toString(),
          data: '0x',
          tokenContract: token.address,
          tokenAmount: '1',
          tokenGas: '50000',
          recoverer: constants.ZERO_ADDRESS,
          index: '0'
        },
        relayData: {
          gasPrice: '1',
          relayWorker: constants.ZERO_ADDRESS,
          callForwarder: factory.address,
          callVerifier: deployVerifier.address,
          domainSeparator: getDomainSeparatorHash(swAddress, chainId)
        }
      }
      const dataToSign = new TypedDeployRequestData(
        chainId,
        factory.address,
        request
      )

      const sig = relayClient.accountManager._signWithControlledKey(eoaWithoutSmartWalletAccount, dataToSign)
      const suffixData = bufferToHex(TypedDataUtils.encodeData(dataToSign.primaryType, dataToSign.message, dataToSign.types).slice((1 + DeployRequestDataType.length) * 32))

      const { logs } = await factory.relayedUserSmartWalletCreation(request.request, getDomainSeparatorHash(factory.address, chainId), suffixData, sig)
      const salt = web3.utils.soliditySha3(
        { t: 'address', v: eoaWithoutSmartWalletAccount.address },
        { t: 'address', v: constants.ZERO_ADDRESS },
        { t: 'address', v: constants.ZERO_ADDRESS },
        { t: 'bytes32', v: soliditySha3Raw({ t: 'bytes', v: '0x' }) },
        { t: 'uint256', v: '0' }
      ) ?? ''

      const expectedSalt = web3.utils.toBN(salt).toString()
      const trxReceipt = await web3.eth.getTransactionReceipt(logs[0].transactionHash)
      const actualGasUsed: number = trxReceipt.cumulativeGasUsed

      // Check the emitted event
      expectEvent.inLogs(logs, 'Deployed', {
        addr: swAddress,
        salt: expectedSalt
      })

      // The Smart Wallet should have been charged for the deploy
      const newBalance = await token.balanceOf(swAddress)
      const expectedBalance = originalBalance.sub(web3.utils.toBN('1'))
      chai.expect(expectedBalance, 'Deployment not paid').to.be.bignumber.equal(newBalance)

      const tenPercertGasCushion = actualGasUsed * 0.1
      const highActual = actualGasUsed + tenPercertGasCushion
      const lowActual = actualGasUsed - tenPercertGasCushion

      assert.isTrue(estimatedGasResult === actualGasUsed ||
        ((lowActual <= estimatedGasResult) && (highActual >= estimatedGasResult)), 'Incorrect estimated gas')
    })

    it('should relay properly with token transfer gas estimation used', async function () {
      const eoaWithoutSmartWalletAccount = await getGaslessAccount()

      // register eoaWithoutSmartWallet account to avoid signing with RSKJ
      relayClient.accountManager.addAccount(eoaWithoutSmartWalletAccount)

      const deployOptions: EnvelopingTransactionDetails = {
        from: eoaWithoutSmartWalletAccount.address,
        to: constants.ZERO_ADDRESS, // No extra logic for the Smart Wallet
        data: '0x', // No extra-logic init data
        gas: '0x1E8480',
        relayHub: relayHub.address,
        callForwarder: factory.address,
        callVerifier: deployVerifier.address,
        clientId: '1',
        tokenContract: token.address,
        tokenAmount: '1',
        tokenGas: '50000',
        isSmartWalletDeploy: true,
        recoverer: constants.ZERO_ADDRESS,
        index: '0'
      }

      const swAddress = await factory.getSmartWalletAddress(eoaWithoutSmartWalletAccount.address, constants.ZERO_ADDRESS, deployOptions.to, soliditySha3Raw({ t: 'bytes', v: deployOptions.data }), '0')
      await token.mint('1000', swAddress)

      // Note: 0x00 is returned by RSK, in Ethereum it is 0x
      assert.equal(await web3.eth.getCode(swAddress), '0x00', 'SmartWallet not yet deployed, it must not have installed code')

      const result = await relayClient.relayTransaction(deployOptions)
      const senderAddress = `0x${result.transaction?.getSenderAddress().toString('hex')}`
      const senderTokenInitialBalance = await token.balanceOf(senderAddress)
      assert.notEqual(senderAddress, constants.ZERO_ADDRESS)

      const relayOptions = {
        from: eoaWithoutSmartWalletAccount.address,
        to: options.to,
        data: options.data,
        relayHub: options.relayHub,
        callForwarder: swAddress,
        callVerifier: options.callVerifier,
        clientId: options.clientId,
        tokenContract: options.tokenContract, // tokenGas is skipped, also smartWalletAddress is not needed since is the forwarder
        tokenAmount: '1',
        isSmartWalletDeploy: false
      }

      const relayingResult = await relayClient.relayTransaction(relayOptions)
      const senderAddressRelay = `0x${relayingResult.transaction?.getSenderAddress().toString('hex')}`
      const senderTokenFinalBalance = await token.balanceOf(senderAddressRelay)

      assert.notEqual(senderAddressRelay, '0xundefined')
      assert.equal(senderAddress, senderAddressRelay)
      assert.equal(senderTokenInitialBalance.toString(), senderTokenFinalBalance.sub(toBN('1')).toString())

      const validTransaction = relayingResult.transaction

      if (validTransaction == null) {
        assert.fail(`validTransaction is null: ${JSON.stringify(relayingResult, replaceErrors)}`)
        return
      }
      const validTransactionHash: string = validTransaction.hash(true).toString('hex')
      const txHash = `0x${validTransactionHash}`
      const res = await web3.eth.getTransactionReceipt(txHash)

      // validate we've got the "SampleRecipientEmitted" event
      // TODO: use OZ test helpers
      const topic: string = web3.utils.sha3('SampleRecipientEmitted(string,address,address,uint256,uint256)') ?? ''
      assert(res.logs.find(log => log.topics.includes(topic)))

      const destination: string = validTransaction.to.toString('hex')
      assert.equal(`0x${destination}`, relayHub.address.toString().toLowerCase())
    })

    it('should fail if a deploy without tokenGas and smartwallet is attempted', async function () {
      const eoaWithoutSmartWalletAccount = await getGaslessAccount()

      // register eoaWithoutSmartWallet account to avoid signing with RSKJ
      relayClient.accountManager.addAccount(eoaWithoutSmartWalletAccount)

      const deployOptions: EnvelopingTransactionDetails = {
        from: eoaWithoutSmartWalletAccount.address,
        to: constants.ZERO_ADDRESS, // No extra logic for the Smart Wallet
        data: '0x', // No extra-logic init data
        gas: '0x1E8480',
        relayHub: relayHub.address,
        callForwarder: factory.address,
        callVerifier: deployVerifier.address,
        clientId: '1',
        tokenContract: token.address,
        tokenAmount: '1',
        // tokenGas: '50000', omitted so it is calculated
        isSmartWalletDeploy: true,
        recoverer: constants.ZERO_ADDRESS,
        index: '0'
      }

      const swAddress = await factory.getSmartWalletAddress(eoaWithoutSmartWalletAccount.address, constants.ZERO_ADDRESS, deployOptions.to, soliditySha3Raw({ t: 'bytes', v: deployOptions.data }), '0')
      await token.mint('1000', swAddress)
      // deployOptions.smartWalletAddress = swAddress  --> The client cannot tell who is the token sender so it cannot estimate the token transfer.
      // calculating the address in the client is not an option because the factory used is not in control of the client (a thus, the method to calculate it, which is not unique)

      // Note: 0x00 is returned by RSK, in Ethereum it is 0x
      assert.equal(await web3.eth.getCode(swAddress), '0x00', 'SmartWallet not yet deployed, it must not have installed code')

      try {
        await relayClient.relayTransaction(deployOptions)
      } catch (error) {
        assert.equal(error.message, 'In a deploy, if tokenGas is not defined, then the calculated SmartWallet address is needed to estimate the tokenGas value')
      }
    })
    it('should deploy properly with token transfer gas estimation used', async function () {
      const eoaWithoutSmartWalletAccount = await getGaslessAccount()

      // register eoaWithoutSmartWallet account to avoid signing with RSKJ
      relayClient.accountManager.addAccount(eoaWithoutSmartWalletAccount)

      const deployOptions: EnvelopingTransactionDetails = {
        from: eoaWithoutSmartWalletAccount.address,
        to: constants.ZERO_ADDRESS, // No extra logic for the Smart Wallet
        data: '0x', // No extra-logic init data
        gas: '0x1E8480',
        relayHub: relayHub.address,
        callForwarder: factory.address,
        callVerifier: deployVerifier.address,
        clientId: '1',
        tokenContract: token.address,
        tokenAmount: '1',
        // tokenGas: '50000', omitted so it is calculated
        isSmartWalletDeploy: true,
        recoverer: constants.ZERO_ADDRESS,
        index: '0'
      }

      const swAddress = await factory.getSmartWalletAddress(eoaWithoutSmartWalletAccount.address, constants.ZERO_ADDRESS, deployOptions.to, soliditySha3Raw({ t: 'bytes', v: deployOptions.data }), '0')
      await token.mint('1000', swAddress)
      deployOptions.smartWalletAddress = swAddress

      // Note: 0x00 is returned by RSK, in Ethereum it is 0x
      assert.equal(await web3.eth.getCode(swAddress), '0x00', 'SmartWallet not yet deployed, it must not have installed code')

      const relayingResult = await relayClient.relayTransaction(deployOptions)
      const validTransaction = relayingResult.transaction

      if (validTransaction == null) {
        assert.fail(`validTransaction is null: ${JSON.stringify(relayingResult, replaceErrors)}`)
        return
      }
      const validTransactionHash: string = validTransaction.hash(true).toString('hex')
      const txHash = `0x${validTransactionHash}`
      const res = await web3.eth.getTransactionReceipt(txHash)
      // validate we've got the "Deployed" event

      const topic: string = web3.utils.sha3('Deployed(address,uint256)') ?? ''
      assert.notEqual(topic, '', 'error while calculating topic')

      assert(res.logs.find(log => log.topics.includes(topic)))
      const eventIdx = res.logs.findIndex(log => log.topics.includes(topic))
      const loggedEvent = res.logs[eventIdx]

      const saltSha = web3.utils.soliditySha3(
        { t: 'address', v: eoaWithoutSmartWalletAccount.address },
        { t: 'address', v: constants.ZERO_ADDRESS },
        { t: 'address', v: deployOptions.to },
        { t: 'bytes32', v: soliditySha3Raw({ t: 'bytes', v: deployOptions.data }) },
        { t: 'uint256', v: '0' }
      ) ?? ''

      assert.notEqual(saltSha, '', 'error while calculating salt')

      const expectedSalt = web3.utils.toBN(saltSha).toString()

      const obtainedEvent = web3.eth.abi.decodeParameters([{ type: 'address', name: 'sWallet' },
        { type: 'uint256', name: 'salt' }], loggedEvent.data)

      assert.equal(obtainedEvent.salt, expectedSalt, 'salt from Deployed event is not the expected one')
      assert.equal(obtainedEvent.sWallet, swAddress, 'SmartWallet address from the Deployed event is not the expected one')

      const destination: string = validTransaction.to.toString('hex')
      assert.equal(`0x${destination}`, relayHub.address.toString().toLowerCase())

      let expectedCode = await factory.getCreationBytecode()
      expectedCode = '0x' + expectedCode.slice(20, expectedCode.length)// only runtime code
      assert.equal(await web3.eth.getCode(swAddress), expectedCode, 'The installed code is not the expected one')
    })

    it('should calculate the estimatedGas for the token transfer in a deployCall', async function () {
      const eoaWithoutSmartWalletAccount = await getGaslessAccount()
      // register eoaWithoutSmartWalletAccount account in RelayClient to avoid signing with RSKJ
      relayClient.accountManager.addAccount(eoaWithoutSmartWalletAccount)
      const swAddress = await factory.getSmartWalletAddress(eoaWithoutSmartWalletAccount.address, constants.ZERO_ADDRESS, constants.ZERO_ADDRESS, soliditySha3Raw({ t: 'bytes', v: '0x' }), '0')
      await token.mint('1000', swAddress)
      await token.mint('2', accounts[0])

      const details: EnvelopingTransactionDetails = {
        from: eoaWithoutSmartWalletAccount.address,
        to: constants.ZERO_ADDRESS, // No extra logic for the Smart Wallet
        data: '0x', // No extra-logic init data
        callForwarder: factory.address,
        callVerifier: deployVerifier.address,
        clientId: '1',
        tokenContract: token.address,
        tokenAmount: '1',
        // tokenGas: '50000', tokeGas is omitted so it is calculated
        recoverer: constants.ZERO_ADDRESS,
        index: '0',
        gasPrice: '0x1',
        gas: toHex('400000'),
        value: '0',
        isSmartWalletDeploy: true,
        useEnveloping: true,
        relayHub: accounts[0],
        smartWalletAddress: accounts[0] // just for mocking up the scenario for the estimate in a deploy
      }

      const estimatedGasResult = await relayClient.estimateTokenTransferGas(details)

      const verifierTokenBalance = await token.balanceOf(deployVerifier.address)

      const tx = await token.transfer(deployVerifier.address, 1, {
        from: accounts[0],
        gasPrice: '1'
      })

      const verifierFinalTokenBalance = await token.balanceOf(deployVerifier.address)
      assert.equal(verifierFinalTokenBalance.toString(), verifierTokenBalance.add(toBN(1)).toString(), 'Token balance of verifier must be one')

      // clean accounts[0]
      await token.transfer(deployVerifier.address, 1, {
        from: accounts[0],
        gasPrice: '1'
      })

      const actualGasUsed: number = tx.receipt.cumulativeGasUsed
      console.log(`gas Used ${actualGasUsed}, estimated gas ${estimatedGasResult}`)

      const tenPercertGasCushion = actualGasUsed * 0.1
      const highActual = actualGasUsed + tenPercertGasCushion
      const lowActual = actualGasUsed - tenPercertGasCushion

      assert.isTrue(estimatedGasResult === actualGasUsed ||
        ((lowActual <= estimatedGasResult) && (highActual >= estimatedGasResult)), 'Incorrect estimated gas')
    })

    it('should calculate the estimatedGas for the token transfer in a relayCall', async function () {
      const eoaWithoutSmartWalletAccount = await getGaslessAccount()
      // register eoaWithoutSmartWalletAccount account in RelayClient to avoid signing with RSKJ
      relayClient.accountManager.addAccount(eoaWithoutSmartWalletAccount)
      const swAddress = await factory.getSmartWalletAddress(eoaWithoutSmartWalletAccount.address, constants.ZERO_ADDRESS, constants.ZERO_ADDRESS, soliditySha3Raw({ t: 'bytes', v: '0x' }), '0')
      await token.mint('1000', swAddress)
      await token.mint('2', accounts[0])

      const details: EnvelopingTransactionDetails = {
        from: eoaWithoutSmartWalletAccount.address,
        to: constants.ZERO_ADDRESS, // not important
        data: '0x',
        callForwarder: accounts[0], // just for mocking up the scenario for the estimate in a deploy
        callVerifier: deployVerifier.address,
        clientId: '1',
        tokenContract: token.address,
        tokenAmount: '1',
        // tokenGas: '50000', tokeGas is omitted so it is calculated
        gasPrice: '0x1',
        gas: toHex('400000'),
        value: '0',
        isSmartWalletDeploy: false,
        useEnveloping: true,
        relayHub: accounts[0]
      }

      const estimatedGasResult = await relayClient.estimateTokenTransferGas(details)

      const verifierTokenBalance = await token.balanceOf(deployVerifier.address)

      const tx = await token.transfer(deployVerifier.address, 1, {
        from: accounts[0],
        gasPrice: '1'
      })
      const actualGasUsed: number = tx.receipt.cumulativeGasUsed

      const verifierFinalTokenBalance = await token.balanceOf(deployVerifier.address)
      assert.equal(verifierFinalTokenBalance.toString(), verifierTokenBalance.add(toBN(1)).toString(), 'Token balance of verifier must be one')

      // clean accounts[0]
      await token.transfer(deployVerifier.address, 1, {
        from: accounts[0],
        gasPrice: '1'
      })

      console.log(`gas Used ${actualGasUsed}, estimated gas ${estimatedGasResult}`)

      const tenPercertGasCushion = actualGasUsed * 0.1
      const highActual = actualGasUsed + tenPercertGasCushion
      const lowActual = actualGasUsed - tenPercertGasCushion

      assert.isTrue(estimatedGasResult === actualGasUsed ||
        ((lowActual <= estimatedGasResult) && (highActual >= estimatedGasResult)), 'Incorrect estimated gas')
    })

    it('should send a SmartWallet create transaction to a relay and receive a signed transaction in response', async function () {
      const eoaWithoutSmartWalletAccount = await getGaslessAccount()

      // register eoaWithoutSmartWallet account to avoid signing with RSKJ
      relayClient.accountManager.addAccount(eoaWithoutSmartWalletAccount)

      const deployOptions: EnvelopingTransactionDetails = {
        from: eoaWithoutSmartWalletAccount.address,
        to: constants.ZERO_ADDRESS, // No extra logic for the Smart Wallet
        data: '0x', // No extra-logic init data
        gas: '0x1E8480',
        relayHub: relayHub.address,
        callForwarder: factory.address,
        callVerifier: deployVerifier.address,
        clientId: '1',
        tokenContract: token.address,
        tokenAmount: '1',
        tokenGas: '50000',
        isSmartWalletDeploy: true,
        recoverer: constants.ZERO_ADDRESS,
        index: '0'
      }

      const swAddress = await factory.getSmartWalletAddress(eoaWithoutSmartWalletAccount.address, constants.ZERO_ADDRESS, deployOptions.to, soliditySha3Raw({ t: 'bytes', v: deployOptions.data }), '0')
      await token.mint('1000', swAddress)

      // Note: 0x00 is returned by RSK, in Ethereum it is 0x
      assert.equal(await web3.eth.getCode(swAddress), '0x00', 'SmartWallet not yet deployed, it must not have installed code')

      const relayingResult = await relayClient.relayTransaction(deployOptions)
      const validTransaction = relayingResult.transaction

      if (validTransaction == null) {
        assert.fail(`validTransaction is null: ${JSON.stringify(relayingResult, replaceErrors)}`)
        return
      }
      const validTransactionHash: string = validTransaction.hash(true).toString('hex')
      const txHash = `0x${validTransactionHash}`
      const res = await web3.eth.getTransactionReceipt(txHash)
      // validate we've got the "Deployed" event

      const topic: string = web3.utils.sha3('Deployed(address,uint256)') ?? ''
      assert.notEqual(topic, '', 'error while calculating topic')

      assert(res.logs.find(log => log.topics.includes(topic)))
      const eventIdx = res.logs.findIndex(log => log.topics.includes(topic))
      const loggedEvent = res.logs[eventIdx]

      const saltSha = web3.utils.soliditySha3(
        { t: 'address', v: eoaWithoutSmartWalletAccount.address },
        { t: 'address', v: constants.ZERO_ADDRESS },
        { t: 'address', v: deployOptions.to },
        { t: 'bytes32', v: soliditySha3Raw({ t: 'bytes', v: deployOptions.data }) },
        { t: 'uint256', v: '0' }
      ) ?? ''

      assert.notEqual(saltSha, '', 'error while calculating salt')

      const expectedSalt = web3.utils.toBN(saltSha).toString()

      const obtainedEvent = web3.eth.abi.decodeParameters([{ type: 'address', name: 'sWallet' },
        { type: 'uint256', name: 'salt' }], loggedEvent.data)

      assert.equal(obtainedEvent.salt, expectedSalt, 'salt from Deployed event is not the expected one')
      assert.equal(obtainedEvent.sWallet, swAddress, 'SmartWallet address from the Deployed event is not the expected one')

      const destination: string = validTransaction.to.toString('hex')
      assert.equal(`0x${destination}`, relayHub.address.toString().toLowerCase())

      let expectedCode = await factory.getCreationBytecode()
      expectedCode = '0x' + expectedCode.slice(20, expectedCode.length)// only runtime code
      assert.equal(await web3.eth.getCode(swAddress), expectedCode, 'The installed code is not the expected one')
    })

    describe('with events listener', () => {
      function eventsHandler (e: RelayEvent): void {
        relayEvents.push(e)
      }

      before('registerEventsListener', () => {
        relayClient = new RelayClient(underlyingProvider, config)
        relayClient.registerEventListener(eventsHandler)

        // register gaslessAccount account to avoid signing with RSKJ
        relayClient.accountManager.addAccount(gaslessAccount)
      })
      it('should call events handler', async function () {
        await relayClient.relayTransaction(options)
        assert.equal(relayEvents.length, 8)
        assert.equal(relayEvents[0].step, 0)
        assert.equal(relayEvents[0].total, 8)
        assert.equal(relayEvents[7].step, 7)
      })
      describe('removing events listener', () => {
        before('registerEventsListener', () => {
          relayEvents = []
          relayClient.unregisterEventListener(eventsHandler)
        })
        it('should call events handler', async function () {
          await relayClient.relayTransaction(options)
          assert.equal(relayEvents.length, 0)
        })
      })
    })
  })

  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  describe('#_calculateDefaultGasPrice()', function () {
    it('should use minimum gas price if calculated is to low', async function () {
      const minGasPrice = 1e18
      const config: Partial<EnvelopingConfig> = {
        logLevel: 5,
        relayHubAddress: relayHub.address,
        minGasPrice,
        chainId: (await getTestingEnvironment()).chainId
      }
      const relayClient = new RelayClient(underlyingProvider, config)
      const calculatedGasPrice = await relayClient._calculateGasPrice()
      assert.equal(calculatedGasPrice, `0x${minGasPrice.toString(16)}`)
    })
  })

  describe('#_attemptRelay()', function () {
    const relayUrl = localhostOne
    const relayWorkerAddress = accounts[1]
    const relayManager = accounts[2]
    const relayOwner = accounts[3]
    let pingResponse: PingResponse
    let relayInfo: RelayInfo
    let optionsWithGas: EnvelopingTransactionDetails

    before(async function () {
      await stakeManager.stakeForAddress(relayManager, 7 * 24 * 3600, {
        from: relayOwner,
        value: (2e18).toString()
      })
      await stakeManager.authorizeHubByOwner(relayManager, relayHub.address, { from: relayOwner })
      await relayHub.addRelayWorkers([relayWorkerAddress], { from: relayManager })
      await relayHub.registerRelayServer(2e16.toString(), '10', 'url', { from: relayManager })
      pingResponse = {
        relayWorkerAddress: relayWorkerAddress,
        relayManagerAddress: relayManager,
        relayHubAddress: relayManager,
        minGasPrice: '',
        ready: true,
        version: ''
      }
      relayInfo = {
        relayInfo: {
          relayManager,
          relayUrl,
          baseRelayFee: '',
          pctRelayFee: ''
        },
        pingResponse
      }
      optionsWithGas = Object.assign({}, options, {
        gas: '0xf4240',
        gasPrice: '0x51f4d5c00'
      })
    })

    it('should return error if view call to \'relayCall()\' fails', async function () {
      const badContractInteractor = new BadContractInteractor(web3.currentProvider as Web3Provider, configure(config), true)
      const relayClient =
        new RelayClient(underlyingProvider, config, { contractInteractor: badContractInteractor })
      await relayClient._init()

      // register gasless account in RelayClient to avoid signing with RSKJ
      relayClient.accountManager.addAccount(gaslessAccount)
      const { transaction, error } = await relayClient._attemptRelay(relayInfo, optionsWithGas)
      assert.isUndefined(transaction)
      assert.equal(error!.message, `local view call to 'relayCall()' reverted: ${BadContractInteractor.message}`)
    })

    it('should report relays that timeout to the Known Relays Manager', async function () {
      const badHttpClient = new BadHttpClient(configure(config), false, false, true)
      const dependencyTree = getDependencies(configure(config), underlyingProvider, { httpClient: badHttpClient })
      const relayClient =
        new RelayClient(underlyingProvider, config, dependencyTree)
      await relayClient._init()

      // register gasless account in RelayClient to avoid signing with RSKJ
      relayClient.accountManager.addAccount(gaslessAccount)

      // @ts-ignore (sinon allows spying on all methods of the object, but TypeScript does not seem to know that)
      sinon.spy(dependencyTree.knownRelaysManager)
      const attempt = await relayClient._attemptRelay(relayInfo, optionsWithGas)
      assert.equal(attempt.error?.message, 'some error describing how timeout occurred somewhere')
      expect(dependencyTree.knownRelaysManager.saveRelayFailure).to.have.been.calledWith(sinon.match.any, relayManager, relayUrl)
    })

    it('should not report relays if error is not timeout', async function () {
      const badHttpClient = new BadHttpClient(configure(config), false, true, false)
      const dependencyTree = getDependencies(configure(config), underlyingProvider, { httpClient: badHttpClient })
      dependencyTree.httpClient = badHttpClient
      const relayClient =
        new RelayClient(underlyingProvider, config, dependencyTree)
      await relayClient._init()

      // register gasless account in RelayClient to avoid signing with RSKJ
      relayClient.accountManager.addAccount(gaslessAccount)

      // @ts-ignore (sinon allows spying on all methods of the object, but TypeScript does not seem to know that)
      sinon.spy(dependencyTree.knownRelaysManager)
      await relayClient._attemptRelay(relayInfo, optionsWithGas)
      expect(dependencyTree.knownRelaysManager.saveRelayFailure).to.have.not.been.called
    })

    it('should return error if transaction returned by a relay does not pass validation', async function () {
      const badHttpClient = new BadHttpClient(configure(config), false, false, false, pingResponse, '0x123')
      let dependencyTree = getDependencies(configure(config), underlyingProvider)
      const badTransactionValidator = new BadRelayedTransactionValidator(true, dependencyTree.contractInteractor, configure(config))
      dependencyTree = getDependencies(configure(config), underlyingProvider, {
        httpClient: badHttpClient,
        transactionValidator: badTransactionValidator
      })
      const relayClient =
        new RelayClient(underlyingProvider, config, dependencyTree)

      await relayClient._init()

      // register gasless account in RelayClient to avoid signing with RSKJ
      relayClient.accountManager.addAccount(gaslessAccount)

      // @ts-ignore (sinon allows spying on all methods of the object, but TypeScript does not seem to know that)
      sinon.spy(dependencyTree.knownRelaysManager)
      const { transaction, error } = await relayClient._attemptRelay(relayInfo, optionsWithGas)
      assert.isUndefined(transaction)
      assert.equal(error!.message, 'Returned transaction did not pass validation')
      expect(dependencyTree.knownRelaysManager.saveRelayFailure).to.have.been.calledWith(sinon.match.any, relayManager, relayUrl)
    })

    describe('#_prepareRelayHttpRequest()', function () {
      const asyncApprovalData = async function (_: RelayRequest): Promise<PrefixedHexString> {
        return await Promise.resolve('0x1234567890')
      }

      it('should use provided approval function', async function () {
        const relayClient =
          new RelayClient(underlyingProvider, config, {
            asyncApprovalData
          })

        // register gasless account in RelayClient to avoid signing with RSKJ
        relayClient.accountManager.addAccount(gaslessAccount)

        const httpRequest = await relayClient._prepareRelayHttpRequest(relayInfo, optionsWithGas)
        assert.equal(httpRequest.metadata.approvalData, '0x1234567890')
      })
    })
  })

  describe('#_broadcastRawTx()', function () {
    // TODO: TBD: there has to be other behavior then that. Maybe query the transaction with the nonce somehow?
    it('should return \'wrongNonce\' if broadcast fails with nonce error', async function () {
      const badContractInteractor = new BadContractInteractor(underlyingProvider, configure(config), true)
      const transaction = new Transaction('0x')
      const relayClient =
        new RelayClient(underlyingProvider, config, { contractInteractor: badContractInteractor })
      const { hasReceipt, wrongNonce, broadcastError } = await relayClient._broadcastRawTx(transaction)
      assert.isFalse(hasReceipt)
      assert.isTrue(wrongNonce)
      assert.equal(broadcastError?.message, BadContractInteractor.wrongNonceMessage)
    })
  })

  describe('multiple relayers', () => {
    let id: string
    before(async () => {
      id = (await snapshot()).result
      await registerRelayer(relayHub)
    })
    after(async () => {
      await revert(id)
    })

    it('should succeed to relay, but report ping error', async () => {
      const relayingResult = await relayClient.relayTransaction(options)
      assert.isNotNull(relayingResult.transaction)
      assert.match(relayingResult.pingErrors.get(cheapRelayerUrl)?.message as string, /ECONNREFUSED/,
        `relayResult: ${_dumpRelayingResult(relayingResult)}`)
    })

    it('use preferred relay if one is set', async () => {
      relayClient = new RelayClient(underlyingProvider, {
        preferredRelays: ['http://localhost:8090'],
        ...config
      })

      relayClient.accountManager.addAccount(gaslessAccount)

      const relayingResult = await relayClient.relayTransaction(options)
      assert.isNotNull(relayingResult.transaction)
      assert.equal(relayingResult.pingErrors.size, 0)

      console.log(relayingResult)
    })
  })
})
