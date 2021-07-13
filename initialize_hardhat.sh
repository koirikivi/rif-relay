#!/bin/bash
set -e

cd "$(dirname "$0")"

export PATH=$PWD/venv/bin:$PATH

truffle migrate --network hardhat | tee deployed_contracts_hardhat
python parse_deployed_contracts.py deployed_contracts_hardhat | tee src/sovryn/hardhat_contracts.json
python generate_relay_config.py src/sovryn/hardhat_contracts.json | tee jsrelay/config/relay-config-hardhat.json

echo "To start relay, run:"
echo "node dist/src/cli/commands/enveloping.js relayer-run --config jsrelay/config/relay-config-hardhat.json"
echo ""
echo "To fund relayer, run:"
python generate_relay_command.py jsrelay/config/relay-config-hardhat.json
