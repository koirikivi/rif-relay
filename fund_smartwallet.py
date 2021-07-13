from argparse import ArgumentParser
import json
import os

from eth_account import Account
from web3 import Web3
from web3.middleware import construct_sign_and_send_raw_middleware

parser = ArgumentParser()
parser.add_argument('contracts_json')
parser.add_argument('smartwallet_address')
parser.add_argument('amount')
parser.add_argument("--rsk-node-url", default='http://localhost:8545')
parser.add_argument('--private-key-file', default='privatekey')
args = parser.parse_args()

with open(args.contracts_json) as f:
    contracts = json.load(f)

with open(args.private_key_file) as f:
    private_key = f.read().strip()

with open(os.path.join(os.path.dirname(__file__), 'build', 'contracts', 'TestToken.json')) as f:
    test_token_data = json.load(f)
    test_token_abi = test_token_data['abi']

web3 = Web3(Web3.HTTPProvider(args.rsk_node_url))
account = Account.from_key(private_key)
web3.middleware_onion.add(construct_sign_and_send_raw_middleware(account))
web3.eth.default_account = account.address

test_token_contract = web3.eth.contract(address=contracts['TestToken'], abi=test_token_abi)
print(
    'Current balance of',
    args.smartwallet_address,
    test_token_contract.functions.balanceOf(args.smartwallet_address).call()
)
amount_wei = Web3.toWei(args.amount, 'ether')
print("Minting", args.amount, f'({amount_wei} wei)')
tx_hash = test_token_contract.functions.mint(amount_wei, args.smartwallet_address).transact()
print("Tx hash", tx_hash.hex())
print("Waiting")
web3.eth.wait_for_transaction_receipt(tx_hash)
