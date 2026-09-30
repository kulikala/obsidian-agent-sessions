import io
import os
import re
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest import mock

from agentsessions import config, skills
from agentsessions.cli import SUBCOMMANDS
from agentsessions.cli import setup as cmd_setup

LAUNCHER = '$HOME/x/bin/agent-sessions'
CLAUDE = '.claude/skills'
CODEX = '.agents/skills'
OPENCODE = '.opencode/skills'


def read(path):
    with open(path, encoding='utf-8') as f:
        return f.read()


class SkillsTestCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.vault = os.path.join(self._tmp.name, 'vault')
        os.makedirs(self.vault)

    def path(self, *parts):
        return os.path.join(self.vault, *parts)

    def files(self):
        out = []
        for root, _dirs, names in os.walk(self.vault):
            out += [os.path.relpath(os.path.join(root, n), self.vault) for n in names]
        return sorted(out)


class TestWantedDirs(unittest.TestCase):
    def test_each_agent_reads_its_own_folder(self):
        self.assertEqual(skills.wanted_dirs(['claude']), [skills.CLAUDE_DIR])
        self.assertEqual(skills.wanted_dirs(['codex']), [skills.CODEX_DIR])
        self.assertEqual(skills.wanted_dirs(['claude', 'codex']), [skills.CLAUDE_DIR, skills.CODEX_DIR])

    def test_opencode_reads_both_so_it_only_needs_a_folder_when_alone(self):
        self.assertEqual(skills.wanted_dirs(['opencode']), [skills.OPENCODE_DIR])
        self.assertEqual(skills.wanted_dirs(['claude', 'opencode']), [skills.CLAUDE_DIR])
        self.assertEqual(skills.wanted_dirs(['codex', 'opencode']), [skills.CODEX_DIR])
        self.assertEqual(skills.wanted_dirs([]), [])


class TestTemplates(unittest.TestCase):
    def test_each_skill_has_the_frontmatter_every_agent_needs(self):
        for name in skills.SKILL_NAMES:
            text = skills.render(name, LAUNCHER)
            self.assertTrue(text.startswith('---\nname: %s\ndescription: ' % name), name)
            head = text.split('---\n')[1]
            self.assertLess(len(head.split('description: ', 1)[1].split('\n')[0]), 1024)
            self.assertIn(skills.MARKER, text)
            self.assertIn('"%s"' % LAUNCHER, text)
            self.assertNotIn('{{', text)

    def test_new_is_user_invoked_only_and_the_others_are_not(self):
        self.assertIn('disable-model-invocation: true', skills.render('agent-sessions-new', LAUNCHER))
        for name in ('agent-sessions-stats', 'agent-sessions-info'):
            self.assertNotIn('disable-model-invocation', skills.render(name, LAUNCHER))

    def test_the_bodies_call_the_commands_that_exist(self):
        for name in skills.SKILL_NAMES:
            calls = re.findall(r'"%s" (\w+)' % re.escape(LAUNCHER), skills.render(name, LAUNCHER))
            self.assertTrue(calls, name)
            for cmd in calls:
                self.assertIn(cmd, SUBCOMMANDS)

    def test_the_default_launcher_is_this_programs_own(self):
        launcher = skills.default_launcher()
        self.assertTrue(launcher.endswith('bin/agent-sessions'))
        self.assertTrue(os.path.exists(os.path.expandvars(launcher.replace('$HOME', os.path.expanduser('~')))))


class TestInstall(SkillsTestCase):
    def test_installs_into_the_folders_of_the_enabled_agents_only(self):
        status, changes = skills.install(self.vault, ['claude', 'codex'], LAUNCHER)
        self.assertEqual(status, skills.INSTALLED)
        self.assertEqual(len(changes), 7)   # 3 + 3 skills and Codex's policy file
        self.assertEqual(self.files(), sorted(
            ['%s/%s/SKILL.md' % (CLAUDE, n) for n in skills.SKILL_NAMES]
            + ['%s/%s/SKILL.md' % (CODEX, n) for n in skills.SKILL_NAMES]
            + ['%s/agent-sessions-new/agents/openai.yaml' % CODEX]))

    def test_nothing_goes_outside_the_vault(self):
        with tempfile.TemporaryDirectory() as home:
            with mock.patch.dict(os.environ, {'HOME': home}):
                skills.install(self.vault, ['claude', 'codex', 'opencode'], LAUNCHER)
            self.assertEqual(os.listdir(home), [])

    def test_a_second_run_changes_nothing(self):
        skills.install(self.vault, ['claude'], LAUNCHER)
        self.assertEqual(skills.install(self.vault, ['claude'], LAUNCHER), (skills.UNCHANGED, []))

    def test_a_changed_launcher_updates_the_files(self):
        skills.install(self.vault, ['claude'], LAUNCHER)
        status, changes = skills.install(self.vault, ['claude'], '/other/agent-sessions')
        self.assertEqual(status, skills.UPDATED)
        self.assertEqual(len(changes), 3)
        self.assertIn('/other/agent-sessions', read(self.path(CLAUDE, 'agent-sessions-info', 'SKILL.md')))

    def test_disabling_an_agent_takes_its_copies_away(self):
        skills.install(self.vault, ['claude', 'codex'], LAUNCHER)
        skills.install(self.vault, ['claude'], LAUNCHER)
        self.assertEqual(self.files(), sorted('%s/%s/SKILL.md' % (CLAUDE, n) for n in skills.SKILL_NAMES))
        self.assertFalse(os.path.exists(self.path('.agents')))

    def test_opencode_alone_moves_to_its_own_folder(self):
        skills.install(self.vault, ['claude'], LAUNCHER)
        skills.install(self.vault, ['opencode'], LAUNCHER)
        self.assertEqual(self.files(), sorted('%s/%s/SKILL.md' % (OPENCODE, n) for n in skills.SKILL_NAMES))

    def test_a_skill_without_the_marker_is_never_overwritten_or_removed(self):
        mine = self.path(CLAUDE, 'agent-sessions-info', 'SKILL.md')
        os.makedirs(os.path.dirname(mine))
        with open(mine, 'w') as f:
            f.write('my own skill\n')
        status, changes = skills.install(self.vault, ['claude'], LAUNCHER)
        self.assertEqual(status, skills.FOREIGN)
        self.assertTrue(any(mine in c for c in changes))
        self.assertEqual(read(mine), 'my own skill\n')
        self.assertTrue(os.path.exists(self.path(CLAUDE, 'agent-sessions-new', 'SKILL.md')))   # the others still go in
        skills.remove(self.vault)
        self.assertEqual(read(mine), 'my own skill\n')
        skills.install(self.vault, ['codex'], LAUNCHER)   # moving away from the Claude folder
        self.assertEqual(read(mine), 'my own skill\n')

    def test_a_foreign_policy_file_is_left_alone(self):
        policy = self.path(CODEX, 'agent-sessions-new', 'agents', 'openai.yaml')
        os.makedirs(os.path.dirname(policy))
        with open(policy, 'w') as f:
            f.write('policy: mine\n')
        status, _ = skills.install(self.vault, ['codex'], LAUNCHER)
        self.assertEqual(status, skills.FOREIGN)
        self.assertEqual(read(policy), 'policy: mine\n')

    def test_update_only_refreshes_copies_that_exist_and_creates_nothing(self):
        self.assertEqual(skills.install(self.vault, ['claude'], LAUNCHER, update_only=True), (skills.ABSENT, []))
        self.assertEqual(self.files(), [])
        skills.install(self.vault, ['claude'], LAUNCHER)
        os.unlink(self.path(CLAUDE, 'agent-sessions-stats', 'SKILL.md'))
        status, _ = skills.install(self.vault, ['claude'], '/other/agent-sessions', update_only=True)
        self.assertEqual(status, skills.UPDATED)
        self.assertFalse(os.path.exists(self.path(CLAUDE, 'agent-sessions-stats', 'SKILL.md')))
        self.assertIn('/other/', read(self.path(CLAUDE, 'agent-sessions-info', 'SKILL.md')))

    def test_update_only_leaves_other_folders_alone(self):
        skills.install(self.vault, ['claude', 'codex'], LAUNCHER)
        skills.install(self.vault, ['claude'], LAUNCHER, update_only=True)
        self.assertTrue(os.path.exists(self.path(CODEX, 'agent-sessions-info', 'SKILL.md')))

    def test_dry_run_writes_nothing(self):
        status, changes = skills.install(self.vault, ['claude'], LAUNCHER, dry_run=True)
        self.assertEqual((status, len(changes)), (skills.INSTALLED, 3))
        self.assertEqual(self.files(), [])

    def test_a_folder_that_cannot_be_written_is_reported_not_raised(self):
        with open(self.path('.claude'), 'w') as f:   # a file where the folder should be
            f.write('x')
        status, changes = skills.install(self.vault, ['claude'], LAUNCHER)
        self.assertEqual(status, skills.FAILED)
        self.assertTrue(changes)


class TestRemove(SkillsTestCase):
    def test_removes_every_copy_of_ours_and_the_folders_it_leaves_empty(self):
        skills.install(self.vault, ['claude', 'codex'], LAUNCHER)
        changes = skills.remove(self.vault)
        self.assertEqual(len(changes), 7)
        self.assertEqual(os.listdir(self.vault), [])

    def test_keeps_other_skills_and_the_folders_that_hold_them(self):
        other = self.path(CLAUDE, 'theirs', 'SKILL.md')
        os.makedirs(os.path.dirname(other))
        with open(other, 'w') as f:
            f.write('theirs\n')
        skills.install(self.vault, ['claude'], LAUNCHER)
        skills.remove(self.vault)
        self.assertEqual(self.files(), ['%s/theirs/SKILL.md' % CLAUDE])

    def test_keeps_a_file_someone_added_to_one_of_our_folders(self):
        skills.install(self.vault, ['claude'], LAUNCHER)
        extra = self.path(CLAUDE, 'agent-sessions-new', 'notes.txt')
        with open(extra, 'w') as f:
            f.write('n')
        skills.remove(self.vault)
        self.assertEqual(self.files(), ['%s/agent-sessions-new/notes.txt' % CLAUDE])

    def test_nothing_to_remove_touches_nothing(self):
        os.makedirs(self.path(CLAUDE))
        self.assertEqual(skills.remove(self.vault), [])
        self.assertTrue(os.path.isdir(self.path(CLAUDE)))


class TestSetupCommand(SkillsTestCase):
    def run_setup(self, *args):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            rc = cmd_setup.main(list(args))
        return rc, out.getvalue(), err.getvalue()

    def test_skills_installs_and_reports_a_status_line(self):
        rc, out, _ = self.run_setup('--skills', '--vault', self.vault, '--agents', 'claude', '--command', LAUNCHER)
        self.assertEqual(rc, 0)
        self.assertEqual(out.strip().splitlines()[-1], 'agent-skills: installed')
        self.assertIn('"%s"' % LAUNCHER, read(self.path(CLAUDE, 'agent-sessions-new', 'SKILL.md')))
        rc, out, _ = self.run_setup('--skills', '--vault', self.vault, '--agents', 'claude', '--command', LAUNCHER)
        self.assertEqual(out.strip().splitlines()[-1], 'agent-skills: unchanged')

    def test_the_agents_come_from_the_enabled_ones_when_not_given(self):
        with mock.patch.dict(os.environ, {'AGENT_SESSIONS_AGENTS': 'codex'}):
            self.run_setup('--skills', '--vault', self.vault)
        self.assertTrue(os.path.exists(self.path(CODEX, 'agent-sessions-new', 'SKILL.md')))
        self.assertFalse(os.path.exists(self.path('.claude')))

    def test_the_vault_falls_back_to_the_configured_one(self):
        with mock.patch.object(config, 'VAULT', self.vault), \
                mock.patch.dict(os.environ, {'AGENT_SESSIONS_AGENTS': 'claude'}):
            self.run_setup('--skills')
        self.assertTrue(os.path.exists(self.path(CLAUDE, 'agent-sessions-info', 'SKILL.md')))

    def test_without_any_vault_it_fails_in_words(self):
        with mock.patch.object(config, 'VAULT', None):
            rc, _, err = self.run_setup('--skills')
        self.assertEqual(rc, 1)
        self.assertIn('--vault', err)

    def test_update_only_creates_nothing(self):
        rc, out, _ = self.run_setup('--skills', '--update-only', '--vault', self.vault, '--agents', 'claude')
        self.assertEqual(rc, 0)
        self.assertEqual(out.strip().splitlines()[-1], 'agent-skills: absent')
        self.assertEqual(self.files(), [])

    def test_remove_skills_removes_only_the_skills(self):
        skills.install(self.vault, ['claude'], LAUNCHER)
        rc, out, _ = self.run_setup('--remove-skills', '--vault', self.vault)
        self.assertEqual(rc, 0)
        self.assertEqual(out.strip().splitlines()[-1], 'agent-skills: removed')
        self.assertEqual(self.files(), [])
        rc, out, _ = self.run_setup('--remove-skills', '--vault', self.vault)
        self.assertEqual(out.strip().splitlines()[-1], 'agent-skills: absent')

    def test_remove_takes_the_skills_away_with_everything_else(self):
        skills.install(self.vault, ['claude', 'codex'], LAUNCHER)
        d = self._tmp.name
        rc, _, _ = self.run_setup('--remove', '--vault', self.vault, '--settings', os.path.join(d, 's.json'),
                                  '--keybindings', os.path.join(d, 'k.json'), '--config-toml', os.path.join(d, 'c.toml'),
                                  '--opencode-plugin', os.path.join(d, 'p.js'),
                                  '--opencode-tui-backup', os.path.join(d, 'b.json'))
        self.assertEqual(rc, 0)
        self.assertEqual(self.files(), [])


if __name__ == '__main__':
    unittest.main()
