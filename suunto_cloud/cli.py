"""Command-line entry point for the application's responsibility-based modules."""

import argparse
from importlib import import_module


COMMANDS = {
    'sync': ('suunto_cloud.synchronization.service', 'Pobierz i przeanalizuj treningi'),
    'oauth': ('suunto_cloud.authentication.oauth', 'Autoryzuj konto Suunto'),
    'access': ('suunto_cloud.authentication.access', 'Konfiguruj klucze i sprawdź dostęp'),
    'workouts': ('suunto_cloud.downloads.workouts', 'Pobierz listę treningów'),
    'track': ('suunto_cloud.downloads.tracks', 'Pobierz FIT lub eksportuj GPX'),
    'analyze': ('suunto_cloud.analysis.command', 'Przeanalizuj zdekodowany FIT'),
    'charts': ('suunto_cloud.reporting.command', 'Wygeneruj wykresy z zapisanego raportu'),
}


def main(argv=None):
    parser = argparse.ArgumentParser(description='Pobieranie i analiza treningów Suunto.')
    commands = parser.add_subparsers(dest='command', required=True)
    for name, (_, description) in COMMANDS.items():
        commands.add_parser(name, help=description, add_help=False)
    args, remaining = parser.parse_known_args(argv)
    module_name, _ = COMMANDS[args.command]
    return import_module(module_name).run(remaining)
