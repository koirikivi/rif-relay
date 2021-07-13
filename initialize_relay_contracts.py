from argparse import ArgumentParser
import json
import os

from eth_account import Account
from web3 import Web3
from web3.middleware import construct_sign_and_send_raw_middleware

parser = ArgumentParser()
parser.add_argument('contracts_json')
parser.add_argument("--rsk-node-url", default='http://localhost:8545')
parser.add_argument('--private-key-file', default='privatekey')
args = parser.parse_args()

with open(args.contracts_json) as f:
    contracts = json.load(f)

with open(args.private_key_file) as f:
    private_key = f.read().strip()

web3 = Web3(Web3.HTTPProvider(args.rsk_node_url))
account = Account.from_key(private_key)
web3.middleware_onion.add(construct_sign_and_send_raw_middleware(account))
web3.eth.default_account = account.address

with open(os.path.join(os.path.dirname(__file__), 'build', 'contracts', 'TestToken.json')) as f:
    test_token_data = json.load(f)
    test_token_abi = test_token_data['abi']

with open(os.path.join(os.path.dirname(__file__), 'build', 'contracts', 'DeployVerifier.json')) as f:
    deploy_verifier_data = json.load(f)
    deploy_verifier_contract = web3.eth.contract(address=contracts['SmartWalletDeployVerifier'], abi=deploy_verifier_data['abi'])

with open(os.path.join(os.path.dirname(__file__), 'build', 'contracts', 'RelayVerifier.json')) as f:
    relay_verifier_data = json.load(f)
    relay_verifier_contract = web3.eth.contract(address=contracts['SmartWalletRelayVerifier'], abi=relay_verifier_data['abi'])

test_token_address = contracts['TestToken']

deploy_verifier_accepts = deploy_verifier_contract.functions.acceptsToken(test_token_address).call()
print('Deploy verifier accepts TestToken:', deploy_verifier_accepts)

relay_verifier_accepts = deploy_verifier_contract.functions.acceptsToken(test_token_address).call()
print('Relay verifier accepts TestToken:', relay_verifier_accepts)

tx_hashes = []
if not deploy_verifier_accepts:
    tx_hash = deploy_verifier_contract.functions.acceptToken(test_token_address).transact()
    print("Tx hash", tx_hash.hex())
    tx_hashes.append(tx_hash)
if not relay_verifier_accepts:
    tx_hash = relay_verifier_contract.functions.acceptToken(test_token_address).transact()
    print("Tx hash", tx_hash.hex())
    tx_hashes.append(tx_hash)

print("Waiting")
for tx_hash in tx_hashes:
    web3.eth.wait_for_transaction_receipt(tx_hash)
