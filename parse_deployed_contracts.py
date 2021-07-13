"""
Parse a file that looks like this into json:

something
foo
|===================================|============================================|
| Contract                          | Address                                    |
|===================================|============================================|
| Penalizer                         | 0x9f38a83F6A08E99aCdC120421deC076266d9a625 |
| RelayHub                          | 0xFf503090902838baA214dEf87d49F6dC5aaBF2cf |
| Smart Wallet Contracts ========================================================|
| SmartWallet                       | 0xd26c052186e9Fad56e9FAA49F467074E4811d884 |
| SmartWalletFactory                | 0x1efC1161e8C20B1811DAeCa32a69832dd33E02Ca |
| SmartWalletDeployVerifier         | 0x68D38817589Cc68329A8555e46a4Aa219F18828E |
| SmartWalletRelayVerifier          | 0xb9559F885CBf048b1695AA866cc9C89F34B7A78d |
| Custom Smart Wallet Contracts =================================================|
| CustomSmartWallet                 | 0x27c370eA14825796E10dC6a546D81A75386284BD |
| CustomSmartWalletFactory          | 0x3BE76b8A1Ade98E1dE16B51219D3C5528edccEdE |
| CustomSmartWalletDeployVerifier   | 0xEd8E9E0F03dA5c9aC8270CaeA6a9c4fE5D04dA7e |
| CustomSmartWalletRelayVerifier    | 0xdb96Eb814198ee7Ccdd12BF89aBA9ca38709D66b |
| Testing Contracts =============================================================|
| SampleRecipient                   | 0xEec5FFef87Fe51A5e72ce244c4aBB97c788608aB |
| TestToken                         | 0xf70bf925596DF3660FA2BF8304Df8Abf2a41ccF8 |
|===================================|============================================|
"""
import json
import fileinput

header_found = False
ret = {}

for line in fileinput.input():
    if not header_found:
        if line == '| Contract                          | Address                                    |\n':
            header_found = True
    else:
        parts = line.split('|')
        # Parts is something like
        # ['', ' SampleRecipient                   ', ' 0xEec5FFef87Fe51A5e72ce244c4aBB97c788608aB ', '\n']
        # if it looks correct
        if len(parts) < 3 or parts[0] != '':
            # didn't start with | or not enough parts
            continue
        if '==' in parts[1]:
            # header
            continue
        contract_name = parts[1].strip()
        contract_address = parts[2].strip()
        ret[contract_name] = contract_address


print(json.dumps(ret, indent=4))
