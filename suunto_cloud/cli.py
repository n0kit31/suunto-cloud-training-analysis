"""Command-line entry point for the application's responsibility-based modules."""

import argparse
from importlib import import_module


COMMANDS = {
    'sync': ('suunto_cloud.synchronization.service', 'Download and analyze workouts'),
    'oauth': ('suunto_cloud.authentication.oauth', 'Authorize a Suunto account'),
    'access': ('suunto_cloud.authentication.access', 'Configure credentials and check access'),
    'workouts': ('suunto_cloud.downloads.workouts', 'Download the workout list'),
    'track': ('suunto_cloud.downloads.tracks', 'Download FIT or export GPX'),
    'analyze': ('suunto_cloud.analysis.command', 'Analyze decoded FIT data'),
    'charts': ('suunto_cloud.reporting.command', 'Generate charts from a saved report'),
}


def main(argv=None):
    parser = argparse.ArgumentParser(description='Download and analyze Suunto workouts.')
    commands = parser.add_subparsers(dest='command', required=True)
    for name, (_, description) in COMMANDS.items():
        commands.add_parser(name, help=description, add_help=False)
    args, remaining = parser.parse_known_args(argv)
    module_name, _ = COMMANDS[args.command]
    return import_module(module_name).run(remaining)
