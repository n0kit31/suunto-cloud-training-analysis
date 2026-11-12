from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from analysis_packet import distance_blocks


class DistanceBlocksTests(unittest.TestCase):
    def laps(self):
        return [dict(index=i + 1, distance_m=1000, active_seconds=300,
                     avg_hr=150 if i < 10 else 170, avg_power_w=280)
                for i in range(20)] + [dict(index=21, distance_m=300, active_seconds=80)]

    def test_equal_distance_excludes_finish_and_groups_do_not_overlap(self):
        result = distance_blocks(self.laps(), {})
        self.assertEqual([b['distance_m'] for b in result['five_km']], [5000] * 4 + [300])
        self.assertEqual([b['avg_hr_bpm'] for b in result['equal_parts']], [150, 170])
        self.assertEqual(result['remainder']['active_seconds'], 80)

    def test_missing_hr_is_not_zero_and_time_weighting_is_used(self):
        laps = self.laps()
        laps[0].update(active_seconds=600, avg_hr=180)
        laps[1]['avg_hr'] = None
        block = distance_blocks(laps, {})['five_km'][0]
        self.assertAlmostEqual(block['avg_hr_bpm'], (180 * 600 + 150 * 900) / 1500)
        self.assertAlmostEqual(block['avg_hr_bpm_coverage'], 1500 / 1800)
        self.assertIsNone(distance_blocks(laps, {})['remainder']['avg_hr_bpm'])

    def test_does_not_treat_guided_or_mixed_distance_laps_as_kilometres(self):
        laps = self.laps()
        laps[3]['distance_m'] = 700
        self.assertIsNone(distance_blocks(laps, {}))

    def test_mechanics_weight_joint_observations(self):
        samples = {1: {'mechanics': {'cadence_steps_per_min': 180}, 'mechanics_paired_count': 100},
                   2: {'mechanics': {'cadence_steps_per_min': 200}, 'mechanics_paired_count': 300}}
        self.assertEqual(distance_blocks(self.laps(), samples)['five_km'][0]['mechanics']['cadence_steps_per_min'], 195)
