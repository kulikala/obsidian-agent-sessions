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

    def test_paths(self):
        self.assertEqual(self.mask('open /home/pat/vault/notes/a.md please'), 'open notes/a.md please')
        self.assertEqual(self.mask('the file /srv/app/src/deep/auth.ts'), 'the file …/deep/auth.ts')
        self.assertEqual(self.mask('in /home/pat/other/proj/x.py'), 'in …/proj/x.py')
        self.assertEqual(self.mask('~/code/repo/main.go'), '…/repo/main.go')
        self.assertEqual(self.mask('run /compact now'), 'run /compact now')
        self.assertEqual(self.mask('C:\\Users\\pat\\proj\\a.txt'), '…/proj/a.txt')
        self.assertEqual(self.mask('home is /home/pat'), 'home is ~')

    def test_folder(self):
        self.assertEqual(self.mask.folder('/home/pat/vault'), '.')
        self.assertEqual(self.mask.folder('/home/pat/vault/projects/x'), 'projects/x')
        self.assertEqual(self.mask.folder('/home/pat/repos/tool'), 'tool')

    def test_words_are_untouched(self):
        for text in ('修正してください', 'Arréglalo, por favor', 'fix the token count'):
            self.assertEqual(self.mask(text), text)


class LimitTest(unittest.TestCase):
    def item(self, task, impact, prompt_len, tools=0):
        return {'task': task, 'impact_w': impact, 'prompts': [{'ref': task + '.p1', 'text': 'a' * prompt_len}],
                'replies': [], 'tools': [{'tool': 'Read'}] * tools}

    def test_drops_smallest_impact_first_then_shortens_prompts(self):
        items = [self.item('t-a', 10, 600), self.item('t-b', 5, 600), self.item('t-c', 20, 600)]
        limit = excerpt.size(items) - 10
        orig_build = excerpt.task_excerpt
        try:
            excerpt.task_excerpt = lambda s, t, m, w: dict(next(i for i in items if i['task'] == t['id']))
            analysed = [{'session': {'id': 's'}, 'tasks': [{'id': i['task'], 'in_range': True} for i in items]}]
            hits = [{'task': i['task'], 'impact_w': i['impact_w'], 'needs_llm': False} for i in items]
            out = excerpt.build(analysed, hits, excerpt.Masker('/h', None), limit=limit)
            self.assertEqual([i['task'] for i in out], ['t-c', 't-a'])
            one = excerpt.size([items[2]])
            out = excerpt.build(analysed, hits, excerpt.Masker('/h', None), limit=one - 100)
            self.assertEqual([i['task'] for i in out], ['t-c'])
            self.assertEqual(len(out[0]['prompts'][0]['text']), excerpt.PROMPT_CHARS_SHORT)
        finally:
            excerpt.task_excerpt = orig_build

    def test_prompt_choice_keeps_first_rework_and_last(self):
        prompts = [{'ref': 'p%d' % i, 'rework': [1] if i in (4, 9) else []} for i in range(12)]
        chosen = [p['ref'] for p in excerpt.pick_prompts(prompts)]
        self.assertEqual(len(chosen), excerpt.MAX_PROMPTS)
        for ref in ('p0', 'p4', 'p9', 'p11'):
            self.assertIn(ref, chosen)


if __name__ == '__main__':
    unittest.main()
