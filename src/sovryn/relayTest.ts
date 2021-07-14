import fs from 'fs';

import Web3 from "web3";
import {AbiItem} from 'web3-utils';

import { RelayProvider } from "../relayclient/RelayProvider";
import { resolveConfiguration } from "../relayclient/Configurator";
import { AccountKeypair } from "../relayclient/AccountManager";
import smartWalletFactoryData from '../../build/contracts/SmartWalletFactory.json';
import ierc20Data from '../../build/contracts/IERC20.json';
import _hardhatContracts from './hardhat_contracts.json';
import _sovrynSwapNetworkAbi from './SovrynSwapNetwork.abi.json';

let tokenContract: string; // token address (DoC) to use on smart wallet
let smartWalletFactoryAddress: string; // the smart wallet factort contract address (can be retrieved from the summary of the deployment).
let relayVerifierAddress: string; // the relay verifier contract address (can be retrieved from the summary of the deployment).
let deployVerifierAddress: string; // the deploy verifier contract address (can be retrieved from the summary of the deployment).
let relayHubAddress: string; // the relay hub contract address (can be retrieved from the summary of the deployment).
let relayUrl: string;
let rpcUrl: string;
let chainId: number;
let sovrynSwapNetworkAddress: string;
let docTokenAddress: string;
let wrbtcTokenAddress: string;

const hardhatContracts = (_hardhatContracts || {}) as any;
const network: string = process.argv[2];
const action: string = process.argv[3];
const toBN = Web3.utils.toBN;

if (network === 'hardhat') {
    tokenContract = hardhatContracts.TestToken; // token address to use on smart wallet
    smartWalletFactoryAddress = hardhatContracts.SmartWalletFactory; // the smart wallet factort contract address (can be retrieved from the summary of the deployment).
    relayVerifierAddress = hardhatContracts.SmartWalletRelayVerifier; // the relay verifier contract address (can be retrieved from the summary of the deployment).
    deployVerifierAddress = hardhatContracts.SmartWalletDeployVerifier; // the deploy verifier contract address (can be retrieved from the summary of the deployment).
    relayHubAddress = hardhatContracts.RelayHub; // the relay hub contract address (can be retrieved from the summary of the deployment).
    relayUrl = "http://localhost:8091";
    rpcUrl = "http://localhost:8545";
    chainId = 31337;
    sovrynSwapNetworkAddress = '';
    docTokenAddress = '';
    wrbtcTokenAddress = '';
} else if (network === 'testnet') {
    //tokenContract = "0xcb46c0ddc60d18efeb0e586c17af6ea36452dae0"; // token address (DoC) to use on smart wallet
    tokenContract = "0x00EC33F09a2408A597EAFF4f79958bBC60db2A9F"; // TestToken
    smartWalletFactoryAddress = "0x6cb6e91dc26a3de5f63a1a4c66b6161be9a2d24b"; // the smart wallet factort contract address (can be retrieved from the summary of the deployment).
    relayVerifierAddress = "0xe337b746c602485d0890b6b63527a8c2a7643255"; // the relay verifier contract address (can be retrieved from the summary of the deployment).
    deployVerifierAddress = "0xbc2699805e76558ab817b205022fd92320de3461"; // the deploy verifier contract address (can be retrieved from the summary of the deployment).
    relayHubAddress = "0xe891cc7212ebd7bba94a47fcfc31f0bf0c085f7b"; // the relay hub contract address (can be retrieved from the summary of the deployment).
    relayUrl = "http://localhost:8090";
    rpcUrl = "https://testnet2.sovryn.app/rpc";
    chainId = 31;
    sovrynSwapNetworkAddress = '0x61172b53423e205a399640e5283e51fe60ec2256';
    docTokenAddress = '0xcb46c0ddc60d18efeb0e586c17af6ea36452dae0';
    wrbtcTokenAddress = '0x69fe5cec81d5ef92600c1a0db1f11986ab3758ab';
} else {
    throw new Error(`unknown network ${network}, must be hardhat or testnet`)
}

const actions = ['deploy-smart-wallet', 'send-jamie-rbtc', 'execute-swap']
if (actions.indexOf(action) === -1) {
    throw new Error(`invalid action ${action}, must be one of: ${actions.join(', ')}`);
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const smartWalletFactoryAbi = smartWalletFactoryData.abi as AbiItem[];// some json containing the abi of the smart wallet factory contract.
const sovrynSwapNetworkAbi = _sovrynSwapNetworkAbi as AbiItem[];
const erc20Abi = ierc20Data.abi as AbiItem[];
const privateKeyFile = `${__dirname}/../../privatekey_user`;
//const privateKeyFile = `${__dirname}/../../privatekey`;

async function main() {
    const web3 = new Web3(rpcUrl);


    let privateKey;
    if (fs.existsSync(privateKeyFile)) {
        privateKey = fs.readFileSync(privateKeyFile, "utf-8");
    } else {
        throw new Error(`Private key not found at "${privateKeyFile}"`)
    }

    const web3Account = web3.eth.accounts.privateKeyToAccount(`0x${privateKey}`);
    console.log("Using account", web3Account.address);
    //console.log("Private key", web3Account.privateKey);

    const privateKeyBuffer = Buffer.from(privateKey, 'hex');

    const account: AccountKeypair = {
        privateKey: privateKeyBuffer,
        address: web3Account.address,
    }

    const smartWalletIndex = 0; // the index of the smart wallet

    const smartWalletAddress = await new web3.eth.Contract(
        smartWalletFactoryAbi,
        smartWalletFactoryAddress
    ).methods.getSmartWalletAddress(
        account.address,
        ZERO_ADDRESS,
        smartWalletIndex
    ).call();
    console.log("smartWalletAddress:", smartWalletAddress);

    const config = await resolveConfiguration((web3.currentProvider as any),
        {
            //verbose: window.location.href.includes("verbose"),
            //verbose: true,
            onlyPreferredRelays: true,
            preferredRelays: [relayUrl],
            gasPriceFactorPercent: 0,
            relayLookupWindowBlocks: 1e5,
            chainId, // testnet
            relayVerifierAddress,
            deployVerifierAddress,
            smartWalletFactoryAddress
        });
    config.relayHubAddress = relayHubAddress;

    const provider = new RelayProvider(web3.currentProvider as any, config);

    provider.addAccount(account);

    web3.setProvider(provider);

    const tokenAmountForRelay = web3.utils.toWei("3.14");

    // TX params that should be set for (almost) all transactions), including the RelayProvider specific params
    const commonTxParams = {
        from: account.address,
        callVerifier: relayVerifierAddress,
        callForwarder: smartWalletAddress,
        isSmartWalletDeploy: false,
        onlyPreferredRelays: true,
        tokenAmount: tokenAmountForRelay,
        tokenContract,
        //retries: 10, // try getting transaction receipt this many times
    }

    if (action === 'deploy-smart-wallet') {
        console.log("Deploying smart wallet");
        const tokenAmount = "5"; // total token amount for the smart wallet, the smart wallet address should have more than this number before calling the deploy.

        // deploy smart wallet
        console.log("Deploying smart wallet...")
        const deployTransaction = await provider.deploySmartWallet({
            from: account.address,
            to: ZERO_ADDRESS,
            gas: "0x27100",
            value: "0",
            callVerifier: deployVerifierAddress,
            callForwarder: smartWalletFactoryAddress,
            tokenContract,
            tokenAmount,
            data: "0x",
            index: smartWalletIndex.toString(),
            recoverer: ZERO_ADDRESS,
            isSmartWalletDeploy: true,
            onlyPreferredRelays: true,
            smartWalletAddress
        });
        console.log('Deploy tx', deployTransaction);
    } else if (action === 'send-jamie-rbtc') {
        if (network !== 'testnet') {
            throw new Error("network must be testnet");
        }
        // relay transaction
        const toAddress = '0x1bb2b1beeda1fb25ee5da9cae6c0f12ced831128';
        const unsigned_tx = {
            // some common web3 transaction with the common parameters.
        };

        const relayTransaction = await web3.eth.sendTransaction({
            ...commonTxParams,
            // actual TX details
            to: toAddress,
            value: web3.utils.toWei('0.005'),
            data: '0x',
            //...unsigned_tx,
        } as any);
        console.log("Relay tx:", relayTransaction)
    } else if (action === 'execute-swap') {
        if (network !== 'testnet') {
            throw new Error("network must be testnet");
        }
        const sellAmount = toBN(web3.utils.toWei('5'));

        const sovrynSwapNetwork = new web3.eth.Contract(sovrynSwapNetworkAbi, sovrynSwapNetworkAddress);
        const docToken = new web3.eth.Contract(erc20Abi, docTokenAddress);
        const conversionPath = await sovrynSwapNetwork.methods.conversionPath(
            docTokenAddress,
            wrbtcTokenAddress
        ).call();
        console.log("Conversion path:", conversionPath);
        const allowance = toBN(await docToken.methods.allowance(
            smartWalletAddress,
            sovrynSwapNetworkAddress
        ).call());
        console.log("Allowance:", allowance.toString());
        if (allowance.lt(sellAmount)) {
            console.log('Approving spending DOC');
            const tx = await docToken.methods.approve(
                sovrynSwapNetworkAddress,
                toBN('2').pow(toBN('256')).sub(toBN(1)),
            ).send(commonTxParams);
            console.log("Approval TX:", tx);
        }

        console.log("Doing swap transaction")
        const tx = await sovrynSwapNetwork.methods.convertByPath(
            conversionPath, // path
            sellAmount.toString(), // amount
            1, // min return
            smartWalletAddress, // beneficiary
            ZERO_ADDRESS, // affiliate account
            '0', // affiliate fee
        ).send(commonTxParams);
        console.log('Tx:', tx);
    }
}

main().then(() => {
    process.exit();
}).catch((e) => {
    console.error(e);
    process.exit(1);
})