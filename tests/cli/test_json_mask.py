import io
import json
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest import mock

from agentsessions import config
from agentsessions.cli import json_cmd


class MaskCommandTests(unittest.TestCase):
    def run_cmd(self, stdin):
        out, err = io.StringIO(), io.StringIO()
        with mock.patch('sys.stdin', io.StringIO(stdin)), mock.patch.object(config, 'VAULT', '/v/vault'), \
                redirect_stdout(out), redirect_stderr(err):
            code = json_cmd.main(['mask'])
        return code, out.getvalue(), err.getvalue()

    def test_masks_each_text_and_cuts_to_the_limit(self):
        req = {'texts': ['key sk-ant-abcdefgh', 'see /v/vault/notes/a.md', 'word ' * 50], 'limit': 20}
        code, out, _err = self.run_cmd(json.dumps(req))
        self.assertEqual(code, 0)
        texts = json.loads(out)['texts']
        self.assertEqual(texts[:2], ['key [secret]', 'see notes/a.md'])
        self.assertEqual(len(texts[2]), 20)

    def test_without_a_limit(self):
        code, out, _err = self.run_cmd(json.dumps({'texts': ['https://u:' + 'p@h/x']}))
        self.assertEqual((code, json.loads(out)), (0, {'texts': ['https://[secret]@h/…']}))

    def test_a_bad_request_is_refused(self):
        for stdin in ('', 'nope', '[]', '{"texts": [1]}', '{"texts": [], "limit": 0}'):
            code, out, err = self.run_cmd(stdin)
            self.assertEqual((code, out), (2, ''), stdin)
            self.assertIn('usage', err)


if __name__ == '__main__':
    unittest.main()
