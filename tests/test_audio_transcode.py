"""Isolate the backend route without starting its database/background workers.

Run: python tests/test_audio_transcode.py [path/to/serverUtama.py]
"""
import ast
import io
from pathlib import Path
import subprocess
import sys
import threading
import types
import unittest
from unittest.mock import Mock
from flask import Flask, Response, stream_with_context


SOURCE = Path(sys.argv.pop(1)) if len(sys.argv) > 1 else Path(__file__).resolve().parents[2] / 'serverUtama.py'


class AudioTranscodeTest(unittest.TestCase):
    def setUp(self):
        request_context = Flask(__name__).test_request_context()
        request_context.push()
        self.addCleanup(request_context.pop)
        tree = ast.parse(SOURCE.read_text(encoding='utf-8'))
        route = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'gdrive_audio_transcode')
        route.decorator_list = []
        self.process = Mock(stdout=io.BytesIO(b'fragment'), **{'poll.return_value': None})
        self.slots = threading.BoundedSemaphore(1)
        self.popen = Mock(return_value=self.process)
        context = {
            'request': types.SimpleNamespace(method='GET', args={}),
            '_verify_stream_token': lambda *args: True,
            'shutil': types.SimpleNamespace(which=lambda name: name),
            '_audio_transcode_slots': self.slots,
            'AUDIO_TRANSCODE_SLOT_WAIT_SECONDS': 0,
            '_get_fresh_gdrive_token': lambda: 'test-token',
            '_clamp_audio_transcode_start': lambda value: 0,
            'AUDIO_TRANSCODE_AUDIO_BITRATE': '192k',
            'subprocess': types.SimpleNamespace(Popen=self.popen, PIPE=subprocess.PIPE, DEVNULL=subprocess.DEVNULL, TimeoutExpired=subprocess.TimeoutExpired),
            'threading': threading,
            'Response': Response,
            'stream_with_context': stream_with_context,
        }
        exec(compile(ast.Module(body=[route], type_ignores=[]), str(SOURCE), 'exec'), context)
        self.response = context['gdrive_audio_transcode']('test-file')
        self.body = self.response.get_app_iter({'REQUEST_METHOD': 'GET'})
        self.addCleanup(self.body.close)

    def assertReleasedOnce(self):
        self.assertTrue(self.process.stdout.closed)
        self.assertTrue(self.slots.acquire(blocking=False))
        self.assertFalse(self.slots.acquire(blocking=False))
        self.process.terminate.assert_called_once()

    def test_disconnect_before_first_read_releases_slot(self):
        self.body.close()
        self.body.close()
        self.assertReleasedOnce()

    def test_disconnect_during_stream_releases_slot(self):
        self.assertEqual(next(self.body), b'fragment')
        self.body.close()
        self.assertReleasedOnce()

    def test_finished_stream_and_response_close_do_not_double_release(self):
        self.assertEqual(b''.join(self.body), b'fragment')
        self.body.close()
        self.assertReleasedOnce()

    def test_hung_process_is_killed_and_reaped(self):
        self.process.wait.side_effect = [subprocess.TimeoutExpired('ffmpeg', 2), 0]
        self.body.close()
        self.process.kill.assert_called_once()
        self.assertEqual(self.process.wait.call_count, 2)
        self.assertReleasedOnce()

    def test_audio_only_conversion_bounds_fragment_delivery(self):
        command = self.popen.call_args.args[0]
        self.assertEqual(command[command.index('-c:v') + 1], 'copy')
        self.assertEqual(command[command.index('-c:a') + 1], 'aac')
        self.assertEqual(command[command.index('-frag_duration') + 1], '1000000')
        self.assertEqual(self.response.headers['X-Accel-Buffering'], 'no')
        self.body.close()


if __name__ == '__main__':
    unittest.main()
