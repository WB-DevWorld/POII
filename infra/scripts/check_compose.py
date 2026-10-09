"""Checks the rendered Dokploy Compose configuration for the invariants the release policy relies on."""
import json
import sys

config = json.load(open(sys.argv[1]))
expected = {
    'db': {'backend'},
    'migrate': {'backend'},
    'api': {'backend'},
    'web': {'backend'},
}
assert set(config['networks']) == {'backend'}, 'Only the internal backend network belongs in source Compose'
assert all(network.get('internal') for network in config['networks'].values()), 'Backend network must be internal'
assert set(config['services']) == set(expected), f"Unexpected services: {sorted(config['services'])}"
for name, service in config['services'].items():
    assert not service.get('ports'), f'{name} publishes a host port'
    assert set(service.get('networks', {})) == expected[name], f'{name} has an unexpected network'
for name in ('migrate', 'api'):
    assert config['services'][name]['image'].startswith('ghcr.io/example/api@sha256:'), f'{name} must run the pinned API digest'
assert config['services']['web']['image'].startswith('ghcr.io/example/web@sha256:'), 'web must run the pinned web digest'
web_env = config['services']['web']['environment']
assert web_env['HOSTNAME'] == '0.0.0.0', 'Web must bind every container interface'
assert str(web_env['PORT']) == '3000', 'Web must listen on the routed container port'
api_env = config['services']['api']['environment']
assert str(api_env['POII_AI_ENABLED']).lower() == 'false', 'AI stays off until providers and caps are configured per environment'
print('Compose: internal network only, no host ports, digest-pinned images, AI off by default')
