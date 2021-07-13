require('ts-node/register/transpile-only')

var HDWalletProvider = require('@truffle/hdwallet-provider')

const privateKeyFile = './privatekey'
const fs = require('fs')
let privateKey
if (fs.existsSync(privateKeyFile)) {
  privateKey = fs.readFileSync(privateKeyFile, { encoding: 'utf8' })
}

module.exports = {
  networks: {
    coverage: { // coverage/trace provider. note that it currently can't run extrnal-process relay.
      provider: require('./coverage-prov.js'),
      verbose: process.env.VERBOSE,
      network_id: '*'
    },
    development: {
      verbose: process.env.VERBOSE,
      host: '127.0.0.1',
      port: 4444,
      network_id: 33,
      gas: 6300000,
      gasPrice: 60000000 // 0.06 gwei
    },
    hardhat: {
      verbose: process.env.VERBOSE,
      host: '127.0.0.1',
      port: 8545,
      network_id: 31337,
      gas: 6300000,
      gasPrice: 60000000 // 0.06 gwei
    },
    testing: {
      verbose: process.env.VERBOSE,
      host: '127.0.0.1',
      port: 4444,
      network_id: 33,
      gas: 6300000,
      gasPrice: 60000000 // 0.06 gwei
    },
    rskdocker: {
      verbose: process.env.VERBOSE,
      host: 'enveloping-rskj',
      port: 4444,
      network_id: 33,
      gas: 6300000,
      gasPrice: 60000000 // 0.06 gwei
    },
    rsk: {
      verbose: process.env.VERBOSE,
      host: '127.0.0.1',
      port: 4444,
      network_id: 33,
      gas: 6300000,
      gasPrice: 60000000 // 0.06 gwei
    },
    rsktestnet: {
      provider: function () {
        // return new PrivateKeyProvider(privateKey, 'https://testnet2.sovryn.app/rpc')
        // return new PrivateKeyProvider(privateKey, 'https://public-node.testnet.rsk.co')
        return new HDWalletProvider(privateKey, 'https://testnet2.sovryn.app/rpc')
      },
      network_id: 31,
      gas: 6300000,
      gasPrice: 60000000, // 0.06 gwei
      networkCheckTimeout: 9999999, // does nothing?
      timeoutBlocks: 20000,
    },
    rskmainnet: {
      provider: function () {
        return new PrivateKeyProvider(privateKey, 'https://mainnet2.sovryn.app/rpc')
      },
      network_id: 30,
      gas: 6300000,
      gasPrice: 60000000, // 0.06 gwei
      networkCheckTimeout: 9999999, // does nothing?
      timeoutBlocks: 20000,
    }
  },
  mocha: {
    slow: 1000,
    reporter: 'eth-gas-reporter',
    reporterOptions: {
      currency: 'USD',
      onlyCalledMethods: true,
      showTimeSpent: true,
      excludeContracts: []
    }
  },
  compilers: {
    solc: {
      version: '0.6.12',
      settings: {
        evmVersion: 'istanbul',
        optimizer: {
          enabled: true,
          runs: 200 // Optimize for how many times you intend to run the code
        }
      }
    }
  }
}
