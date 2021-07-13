from argparse import ArgumentParser
import json
from eth_account import Account

parser = ArgumentParser()
parser.add_argument('relayer_config_json')
parser.add_argument('--private-key-file', default='privatekey')
args = parser.parse_args()

with open(args.private_key_file) as f:
    private_key = f.read().strip()

with open(args.relayer_config_json) as f:
    relayer_config = json.load(f)

account = Account.from_key(private_key)

print(
    "node dist/src/cli/commands/enveloping.js relayer-register "
    f"--network {relayer_config['rskNodeUrl']} "
    f"-m {args.private_key_file} "
    f"--funds 0.001 "
    f"--relayUrl http://{relayer_config['url']}:{relayer_config['port']} "
    f"--from {account.address} "
    f"--stake 0.001 "
    f"--hub {relayer_config['relayHubAddress']}"
)