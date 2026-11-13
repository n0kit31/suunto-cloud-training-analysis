from copy import deepcopy
import unittest

from suunto_cloud.analysis.chart_metrics import grade_samples, step_length


class ChartMetricTests(unittest.TestCase):
    def rows(self, count=60, grade=10):
        return [(t, {'distance': 2 * t, 'altitude': 100 + grade / 100 * 2 * t})
                for t in range(count)]

    def test_step_is_single_step_from_paired_measurements(self):
        self.assertAlmostEqual(step_length({'speed': 3, 'cadence': 75}), 1.2)
        for row in ({'speed': 3}, {'cadence': 75}, {'speed': 0, 'cadence': 75},
                    {'speed': 3, 'cadence': 0}, {'speed': float('nan'), 'cadence': 75}):
            self.assertIsNone(step_length(row))

    def test_grade_of_linear_hill_is_percent_not_degrees(self):
        for grade in (10, -5, 0):
            rows = self.rows(grade=grade)
            before = deepcopy(rows)
            result = grade_samples(rows, [(0, 60)])
            self.assertEqual(len(result), 60)
            for _, value in result:
                self.assertAlmostEqual(value, grade)
            self.assertEqual(rows, before)

    def test_grade_does_not_cross_pauses_or_missing_inputs(self):
        rows = self.rows()
        for when, row in rows:
            if when >= 40:
                row['altitude'] += 100
        result = grade_samples(rows, [(0, 20), (40, 60)])
        self.assertTrue(result)
        self.assertTrue(all(abs(value - 10) < 1e-8 for _, value in result))
        short = self.rows(count=20)
        del short[9][1]['altitude']
        self.assertEqual(grade_samples(short, [(0, 20)]), [])

    def test_grade_handles_distance_quantization_without_stationary_estimates(self):
        rows = [(t, {'distance': t // 2, 'altitude': 100 + (t // 2) / 10})
                for t in range(120)]
        result = grade_samples(rows, [(0, 120)])
        self.assertTrue(result)
        self.assertTrue(all(t % 2 == 0 and abs(value - 10) < 1e-8 for t, value in result))
        stationary = [(t, {'distance': 0, 'altitude': t}) for t in range(60)]
        self.assertEqual(grade_samples(stationary, [(0, 60)]), [])

    def test_grade_rejects_short_distance_and_does_not_cross_resets(self):
        self.assertEqual(grade_samples(self.rows(count=10), [(0, 10)]), [])
        rows = [(t, {'distance': 2 * (t % 30), 'altitude': 100 if t < 30 else 200})
                for t in range(60)]
        self.assertTrue(all(value == 0 for _, value in grade_samples(rows, [(0, 60)])))

    def test_grade_does_not_cross_recording_gaps(self):
        rows = self.rows()
        rows = [(t, row) for t, row in rows if t < 25 or t >= 35]
        for t, row in rows:
            if t >= 35:
                row['altitude'] += 100
        result = grade_samples(rows, [(0, 60)])
        self.assertTrue(result)
        self.assertTrue(all(abs(value - 10) < 1e-8 for _, value in result))
