from datetime import date
import unittest
from unittest.mock import Mock, patch
from zoneinfo import ZoneInfo

from suunto_cloud.downloads import workouts


def page(*times):
    return [{'workoutKey': f'synthetic-{key}', 'lastModified': time}
            for key, time in enumerate(times)]


class WorkoutPaginationTests(unittest.TestCase):
    @patch.object(workouts, 'PAGE_SIZE', 2)
    def test_keeps_workouts_tied_at_a_page_boundary_and_deduplicates_overlap(self):
        rows = page(30, 20, 20, 20, 10)
        fetch = Mock(side_effect=[{'payload': rows[:2]}, {'payload': rows[1:3]},
                                  {'payload': rows[1:]}, {'payload': rows[-1:]}])
        result = workouts.paginated_workouts(fetch)
        self.assertEqual(result['payload'], rows)
        self.assertEqual(result['metadata']['pages'], 4)
        self.assertEqual(fetch.call_args_list[1].kwargs, {'until': 21, 'limit': 2})
        self.assertEqual(fetch.call_args_list[2].kwargs, {'until': 21, 'limit': 4})

    @patch.object(workouts, 'PAGE_SIZE', 2)
    def test_lower_bound_includes_all_workouts_at_local_midnight(self):
        cutoff = workouts.date_cutoff(date(2026, 11, 16), ZoneInfo('Europe/Warsaw'))
        self.assertEqual(cutoff, 1794783600000)
        rows = page(cutoff + 5, cutoff, cutoff - 1)
        fetch = Mock(side_effect=[{'payload': rows[:2]}, {'payload': rows[1:]}])
        self.assertEqual(workouts.paginated_workouts(fetch, cutoff=cutoff)['payload'], rows)
        self.assertEqual(fetch.call_count, 2)

    @patch.object(workouts, 'PAGE_SIZE', 2)
    @patch.object(workouts, 'MAX_PAGE_SIZE', 2)
    def test_stalled_cursor_and_ignored_cursor_fail_instead_of_claiming_completion(self):
        rows = page(30, 20, 20)
        for second, message in ((rows[1:], 'stalled'), (rows[:2], 'ignored')):
            with self.subTest(message=message), self.assertRaisesRegex(ValueError, message):
                workouts.paginated_workouts(Mock(side_effect=[{'payload': rows[:2]}, {'payload': second}]))
