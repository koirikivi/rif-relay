const fs = require('fs')

require("@nomiclabs/hardhat-ethers");
const { task } = require("hardhat/config");

const ethers = require('ethers');

const privateKeyFile = './privatekey'
let privateKey
if (fs.existsSync(privateKeyFile)) {
  privateKey = fs.readFileSync(privateKeyFile, { encoding: 'utf8' })
}

task("accounts", "Prints the list of accounts", async (_, hre) => {
  const accounts = await hre.ethers.getSigners();

  for (const account of accounts) {
    const balance = await account.getBalance();
    console.log(
      account.address,
      balance.toString(),
      ethers.utils.formatUnits(balance, 'ether'),
    )
  }
});

/**
 * @type import('hardhat/config').HardhatUserConfig
 */
module.exports = {
  solidity: "0.6.12",
  networks: {
    hardhat: {
      accounts: [{
        privateKey,
        balance: ethers.utils.parseEther("1000").toString()
      }],
      mining: {
        interval: 5000
      },
      gas: 7000000,
      gasPrice: 1000,
    }
  }
};
