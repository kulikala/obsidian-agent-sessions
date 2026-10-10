import unittest

from agentsessions.efficiency import excerpt


class MaskTest(unittest.TestCase):
    def setUp(self):
        self.mask = excerpt.Masker(home='/home/pat', vault='/home/pat/vault')

    def test_secrets(self):
        for secret in ('sk-ant-api03-abcdefgh', 'sk-abcdefghijkl', 'ghp_abcdefghij12', 'gho_abcdefghij12',
                       'github_pat_abcdefgh12', 'xoxb-1234-abcd', 'AKIAABCDEFGHIJKLMNOP',
                       'eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl', '0123456789abcdef0123456789abcdef',
                       'Qm9vbXNoYWthbGFrYTEyMzQ1Njc4OTBhYmNkZWZn'):
            self.assertEqual(self.mask('x %s y' % secret), 'x [secret] y', secret)
        self.assertEqual(self.mask('Authorization: Bearer abc.def'), 'Authorization: [secret]')
        self.assertEqual(self.mask('API_KEY=hunter2 and password: swordfish'),
                         '[secret] and [secret]')

    def test_email_and_url(self):
        self.assertEqual(self.mask('mail pat@example.org now'), 'mail [email] now')
        self.assertEqual(self.mask('see https://example.com/a/b?c=1 and http://host.test'),
                         'see https://example.com/… and http://host.test')

    def test_more_token_formats(self):
        for secret in ('sk_live_abc123def456', 'rk_live_abc123def456', 'pk_test_abc123def456',
                       'whsec_abc123def456', 'xapp-1-A0B1-2345-abcdef', 'xoxa-2-abc', 'xoxe-1-abc',
                       'xoxs-abc-def', 'ghu_abcdefghij12', 'ghs_abcdefghij12', 'ghr_abcdefghij12',
                       'glpat-abcdefgh1234', 'ASIAABCDEFGHIJKLMNOP', 'AIza' + 'A' * 35,
                       'ya29.a0AbCdEf123', 'hf_' + 'a1' * 10, 'npm_' + 'b2' * 10, 'pypi-' + 'Ag' * 10,
                       'SG.' + 'a' * 20 + '.' + 'b' * 20):
            self.assertEqual(self.mask('x %s y' % secret), 'x [secret] y', secret)
        self.assertEqual(self.mask('Authorization: Basic dXNlcjpwYXNz'), 'Authorization: [secret]')
        key = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\nAAAA\n-----END OPENSSH PRIVATE KEY-----'
        self.assertEqual(self.mask('key: %s done' % key), 'key: [secret] done')
        self.assertEqual(self.mask('-----BEGIN RSA PRIVATE KEY-----\nMIIEow cut'), '[secret]')
        self.assertEqual(self.mask('pk_primary sk_name'), 'pk_primary sk_name')

    def test_credentials_and_queries_in_urls(self):
        cases = {
            'postgres://admin:S3cr3t!@localhost:5432/app': 'postgres://[secret]@localhost:5432/…',
            'https://bob:hunter2@db.internal/x': 'https://[secret]@db.internal/…',
            'redis://:p@ss@cache:6379': 'redis://[secret]@cache:6379',
            'https://api.example.com?key=abcd1234&sig=zz': 'https://api.example.com/…',
            'https://example.com#access_token=abc': 'https://example.com/…',
            'ftp://user@host.test': 'ftp://[secret]@host.test',
            'connect admin:S3cr3t!@db.local now': 'connect [secret]@db.local now',
        }
        for text, want in cases.items():
            self.assertEqual(self.mask(text), want, text)

    def test_windows_network_paths(self):
        self.assertEqual(self.mask('open \\\\fileserver\\share\\secret.txt now'), 'open \\\\…\\secret.txt now')
        self.assertEqual(self.mask('map \\\\fileserver\\share'), 'map \\\\…')
        self.assertNotIn('fileserver', self.mask('\\\\fileserver\\a\\b\\c.txt'))

    def test_limit_cuts_before_and_after_masking(self):
        text = 'word ' * 100 + 'sk-ant-' + 'a' * 50
        got = self.mask(text, 60)
        self.assertEqual(len(got), 60)
        # A secret that the first cut splits is gone, not kept in part.
        tail = 'x ' * 30 + 'Qm9vbXNoYWthbGFrYTEyMzQ1Njc4OTBhYmNkZWZn' * 10
        self.assertNotIn('Qm9v', self.mask(tail, 40))
        self.assertEqual(self.mask('short', 60), 'short')

    def test_long_runs_are_masked_in_linear_time(self):
        import time
        runs = ['z' * 80000, 'z.' * 40000, 'a@' * 40000, 'a:' * 40000, '/a' * 40000,
                '\\\\a' * 20000, 'a1' * 40000, 'abc' * 26667 + 'g', 'x://' * 20000]
        for text in runs:
            started = time.perf_counter()
            self.mask(text)
            self.assertLess(time.perf_counter() - started, 1.0, text[:12])
        started = time.perf_counter()
        self.mask('z' * 80000, 600)
        self.assertLess(time.perf_counter() - started, 0.1)

    def test_paths(self):
        self.assertEqual(self.mask('open /home/pat/vault/notes/a.md please'), 'open notes/a.md please')
        self.assertEqual(self.mask('the file /srv/app/src/deep/auth.ts'), 'the file …/deep/auth.ts')
        self.assertEqual(self.mask('in /home/pat/other/proj/x.py'), 'in …/proj/x.py')
        self.assertEqual(self.mask('~/code/repo/main.go'), '…/repo/main.go')
        self.assertEqual(self.mask('run /compact now'), 'run /compact now')
        self.assertEqual(self.mask('C:\\Users\\pat\\proj\\a.txt'), '~\\proj\\a.txt')
        self.assertEqual(self.mask('home is /home/pat'), 'home is ~')

    def test_folder(self):
        self.assertEqual(self.mask.folder('/home/pat/vault'), '.')
        self.assertEqual(self.mask.folder('/home/pat/vault/projects/x'), 'projects/x')
        self.assertEqual(self.mask.folder('/home/pat/repos/tool'), 'tool')

    def test_words_are_untouched(self):
        for text in ('修正してください', 'Arréglalo, por favor', 'fix the token count'):
            self.assertEqual(self.mask(text), text)


class UserNameTest(unittest.TestCase):
    """The home folder and the user name, in every form, never reach a model."""

    def setUp(self):
        self.mask = excerpt.Masker(home='/Users/alex', vault='/Users/alex/vault', users=['alex', 'sam'])

    def test_home_folders_of_every_system(self):
        cases = {
            'open /Users/alex/Applications now': 'open ~/Applications now',
            'in /home/alex/src/app/main.py': 'in …/app/main.py',
            'C:\\Users\\alex\\Desktop': '~\\Desktop',
            'C:/Users/Alex/Desktop': '~/Desktop',
            'd:\\users\\ALEX': '~',
            'see /mnt/c/Users/alex/notes.txt': 'see ~/notes.txt',
            'the folder ~/projects/x': 'the folder ~/projects/x',
            'the folder ~/projects/x/y.md': 'the folder …/x/y.md',
            '/Users/sam/Documents': '~/Documents',
        }
        for text, want in cases.items():
            got = self.mask(text)
            self.assertEqual(got, want, text)
            self.assertNotRegex(got.lower(), 'alex|/sam')

    def test_claude_project_folder_names(self):
        self.assertEqual(self.mask('-Users-alex-Library-Mobile-Documents'), '-~-Library-Mobile-Documents')
        self.assertEqual(self.mask('C--Users-alex-work'), '-~-work')
        self.assertNotIn('alex', self.mask('~/.claude/projects/-Users-alex-work-repo/a.jsonl'))

    def test_the_name_alone_between_separators(self):
        self.assertEqual(self.mask('backup at /srv/alex/data'), 'backup at /srv/[user]/data')
        self.assertEqual(self.mask('the share \\\\nas\\alex\\docs'), 'the share \\\\…\\docs')
        self.assertEqual(self.mask.path('/var/lib/alex'), '…/lib/[user]')
        self.assertEqual(self.mask.folder('/Users/alex'), '~')
        self.assertEqual(self.mask.folder('/srv/alex'), '[user]')
        self.assertEqual(self.mask.path('/Users/alex/vault/alex/a.md'), '[user]/a.md')

    def test_what_is_not_a_user_name_is_left(self):
        for text in ('alex wrote this', 'the alex-tools repo', 'src/alexX/a.py',
                     'Users/alexx/a', 'a/sam.md', 'the /Users folder', '修正してください'):
            self.assertEqual(self.mask(text), text, text)
        # Two letters: only the home folder forms, never alone.
        short = excerpt.Masker(home='/Users/jo', users=['jo'])
        self.assertEqual(short('/Users/jo/x and /srv/jo/y'), '~/x and …/jo/y')

    def test_user_names_come_from_the_login_and_the_home_folder(self):
        names = excerpt.user_names('/home/pat')
        self.assertIn('pat', names)
        import getpass
        self.assertIn(getpass.getuser(), names)


if __name__ == '__main__':
    unittest.main()
