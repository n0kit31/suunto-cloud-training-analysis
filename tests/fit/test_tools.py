import json
import shutil
import subprocess
import unittest

from suunto_cloud.fit import SCRIPTS_DIRECTORY


@unittest.skipUnless(shutil.which('node'), 'Node.js is required for FIT tool integration tests')
class FitToolTests(unittest.TestCase):
    def test_relocated_decoder_and_gpx_exporter_load_together(self):
        script = '''
            const path = require('node:path');
            const tools = process.argv[1];
            const decoder = require(path.join(tools, 'decode.cjs'));
            const { trackFromRecords } = require(path.join(tools, 'export_gpx.cjs'));
            if (typeof decoder.decode !== 'function') throw new Error('Missing decoder');
            const result = trackFromRecords({ records: [
                { timestamp: '2026-01-15T12:00:00Z', position_lat: 0, position_long: 0 },
                { timestamp: '2026-01-15T12:00:01Z', position_lat: 0, position_long: 0.001 }
            ] }, 'synthetic');
            process.stdout.write(JSON.stringify(result));
        '''
        result = subprocess.run(['node', '-e', script, str(SCRIPTS_DIRECTORY)],
                                text=True, capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        output = json.loads(result.stdout)
        self.assertEqual(output['summary']['gps_point_count'], 2)
        self.assertEqual(output['summary']['segment_count'], 1)
        self.assertIn('<trkpt lat="0" lon="0.001">', output['gpx'])
