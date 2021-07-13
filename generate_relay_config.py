from argparse import ArgumentParser
import json
import os

parser = ArgumentParser()
parser.add_argument('contracts_json')
parser.add_argument("--host", default='localhost')
parser.add_argument("--port", type=int, default=8091)
parser.add_argument("--gas-price-factor", type=int, default=1)
parser.add_argument("--rsk-node-url", default='http://localhost:8545')
parser.add_argument("--dev-mode", type=bool, default=True)
parser.add_argument("--custom-replenish", type=bool, default=False)
parser.add_argument("--log-level", type=int, default=1)
parser.add_argument("--workdir", default='hardhat_env')
args = parser.parse_args()

with open(args.contracts_json) as f:
    contracts = json.load(f)

work_dir = args.workdir
if not work_dir.startswith('/'):
    #work_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), work_dir))
    work_dir = os.path.abspath(work_dir)

ret = {
    "url": args.host,
    "port": args.port,
    "relayHubAddress": contracts['RelayHub'],
    "relayVerifierAddress": contracts['SmartWalletRelayVerifier'],
    "deployVerifierAddress": contracts['SmartWalletDeployVerifier'],
    "gasPriceFactor": args.gas_price_factor,
    "rskNodeUrl": args.rsk_node_url,
    "devMode": args.dev_mode,
    "customReplenish": args.custom_replenish,
    "logLevel": args.log_level,
    "workdir": work_dir
}
print(json.dumps(ret, indent=4))
