import unittest

from agentsessions.daemon import cmdline


class TestShimArgument(unittest.TestCase):
    def test_a_plain_word_stays_as_it_is(self):
        self.assertEqual(cmdline.shim_argument('--resume'), '--resume')
        self.assertEqual(cmdline.shim_argument('0a1b-2c'), '0a1b-2c')
        self.assertEqual(cmdline.shim_argument('a\\'), 'a\\')

    def test_metacharacters_are_quoted_and_escaped_twice(self):
        # The same text as plugin/src/backend/windows.ts's cmdShimArgument.
        self.assertEqual(cmdline.shim_argument('--name=R&D: 50% done'),
                         '^^^"--name=R^^^&D:^^^ 50^^^%^^^ done^^^"')
        self.assertEqual(cmdline.shim_argument('x|y'), '^^^"x^^^|y^^^"')
        self.assertEqual(cmdline.shim_argument('--name=日本 語'), '^^^"--name=日本^^^ 語^^^"')

    def test_quotes_and_trailing_backslashes_follow_the_c_runtime(self):
        self.assertEqual(cmdline.shim_argument('say "hi"'), '^^^"say^^^ \\^^^"hi\\^^^"^^^"')
        self.assertEqual(cmdline.shim_argument('a b\\'), '^^^"a^^^ b\\\\^^^"')

    def test_line_breaks_go_in_as_spaces(self):
        # cmd.exe ends its line at a line break; the same as windows.ts's cmdShimArgument.
        self.assertEqual(cmdline.shim_argument('one\r\ntwo\n\nthree'), cmdline.shim_argument('one two three'))
        self.assertNotIn('\n', cmdline.shim_line(['C:\\x\\codex.cmd', '--', 'a\nb']))

    def test_an_empty_argument_is_kept(self):
        self.assertEqual(cmdline.shim_argument(''), '^^^"^^^"')


class TestShimLine(unittest.TestCase):
    def test_the_batch_file_is_quoted_for_the_c_runtime_and_the_rest_escaped(self):
        self.assertEqual(
            cmdline.shim_line(['C:\\Program Files\\nodejs\\claude.cmd', '--resume', 'abc', '--name=A & B']),
            '"C:\\Program Files\\nodejs\\claude.cmd" --resume abc ^^^"--name=A^^^ ^^^&^^^ B^^^"')


if __name__ == '__main__':
    unittest.main()
