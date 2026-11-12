from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from analyze_fit import timer_intervals


class TimerTests(unittest.TestCase):
    def test_repeated_stop_does_not_shorten_pause(self):
        events = [{'event': 'timer', 'event_type': kind, 'timestamp': '2026-11-10T17:' + at + '.000Z'}
                  for kind, at in [('start', '16:09'), ('stop', '27:49'), ('stop', '36:47'),
                                   ('start', '39:27'), ('stop', '49:27')]]
        result = timer_intervals(events)
        self.assertEqual(result['pause_seconds_from_rounded_events'], 698)
        self.assertEqual(len(result['pauses']), 1)
        self.assertEqual(len(result['repeated_stop_events']), 1)
        self.assertEqual(len(result['active_segments']), 2)


if __name__ == '__main__':
    unittest.main()
