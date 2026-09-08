"""Run with the backend's Flask environment: python tests/test_frontend_routes.py [backend path]."""
import ast
import os
from pathlib import Path
import sys
import tempfile
import unittest
from flask import Flask, jsonify, send_from_directory

SOURCE = Path(sys.argv.pop(1)) if len(sys.argv) > 1 else Path(__file__).resolve().parents[2] / 'serverUtama.py'


class FrontendRoutesTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        root = Path(directory.name)
        (root / 'assets').mkdir()
        (root / 'assets' / 'app-test.js').write_text('export default 1', encoding='utf-8')
        (root / 'index.html').write_text('<html>Application</html>', encoding='utf-8')
        (root / 'sw.js').write_text('self.addEventListener("fetch", () => {})', encoding='utf-8')
        app = Flask(__name__, static_folder=str(root))
        tree = ast.parse(SOURCE.read_text(encoding='utf-8'))
        route = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'serve_fe')
        route.decorator_list = []
        context = {'app': app, 'os': os, 'jsonify': jsonify, 'send_from_directory': send_from_directory}
        exec(compile(ast.Module(body=[route], type_ignores=[]), str(SOURCE), 'exec'), context)
        app.add_url_rule('/', defaults={'path': ''}, view_func=context['serve_fe'])
        app.add_url_rule('/<path:path>', view_func=context['serve_fe'])
        self.client = app.test_client()

    def test_missing_chunks_are_not_the_application_document(self):
        for path in ['/assets/removed.js', '/assets/removed.css', '/src/main.jsx', '/missing.js', '/api/missing']:
            with self.client.get(path) as response:
                self.assertEqual(response.status_code, 404)
                self.assertNotIn(b'<html>', response.data)

    def test_existing_module_keeps_javascript_mime(self):
        with self.client.get('/assets/app-test.js') as response:
            self.assertEqual(response.status_code, 200)
            self.assertIn(response.mimetype, ['text/javascript', 'application/javascript'])
            self.assertIn('immutable', response.headers['Cache-Control'])

    def test_html_and_client_routes_revalidate(self):
        for path in ['/', '/index.html', '/watch', '/profile/settings']:
            with self.client.get(path) as response:
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.mimetype, 'text/html')
                self.assertEqual(response.headers['Cache-Control'], 'no-cache')

    def test_service_worker_cannot_remain_stale_in_http_cache(self):
        with self.client.get('/sw.js') as response:
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.headers['Cache-Control'], 'no-store')


if __name__ == '__main__':
    unittest.main()
