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


def skill_files(base, names=skills.SKILL_NAMES):
    """Every file the install writes under `base` (relative to the vault), for `names`."""
    return ['%s/%s/%s' % (base, n, f) for n in names for f in skills.template_files(n)]


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
            self.assertEqual('"%s"' % LAUNCHER in text, name == 'agent-sessions', name)
            self.assertNotIn('{{', text)

    def test_there_are_two_skills_and_the_model_may_invoke_them(self):
        self.assertEqual(skills.SKILL_NAMES, ('agent-sessions', 'agent-sessions-help'))
        for name in skills.SKILL_NAMES:
            self.assertNotIn('disable-model-invocation', skills.render(name, LAUNCHER))
        self.assertIn('Only when the user explicitly asks for a new session', skills.render('agent-sessions', LAUNCHER))

    def test_the_body_covers_new_stats_and_other_sessions(self):
        calls = set(re.findall(r'"%s" (\w+)' % re.escape(LAUNCHER), skills.render('agent-sessions', LAUNCHER)))
        self.assertEqual(calls, {'new', 'stats', 'show', 'sessions'})

    def test_the_body_never_tells_the_agent_to_invent_a_prompt(self):
        text = skills.render('agent-sessions', LAUNCHER)
        self.assertIn('never make one up', text)
        self.assertNotIn('short greeting', text)

    def test_the_bodies_call_the_commands_that_exist(self):
        for name in skills.SKILL_NAMES:
            calls = re.findall(r'"%s" (\w+)' % re.escape(LAUNCHER), skills.render(name, LAUNCHER))
            self.assertEqual(bool(calls), name == 'agent-sessions', name)
            for cmd in calls:
                self.assertIn(cmd, SUBCOMMANDS)

    def test_the_default_launcher_is_this_programs_own(self):
        launcher = skills.default_launcher()
        self.assertTrue(launcher.endswith('bin/agent-sessions'))
        self.assertTrue(os.path.exists(os.path.expandvars(launcher.replace('$HOME', os.path.expanduser('~')))))


class TestRenderedForAgents(unittest.TestCase):
    NAMES = {'claude': 'Claude Code', 'codex': 'Codex', 'opencode': 'OpenCode'}

    def combos(self):
        import itertools
        for n in (1, 2, 3):
            for c in itertools.combinations(('claude', 'codex', 'opencode'), n):
                yield list(c)

    def test_there_are_seven_combinations(self):
        self.assertEqual(len(list(self.combos())), 7)

    def test_each_text_names_exactly_the_enabled_agents(self):
        for agents in self.combos():
            text = skills.render('agent-sessions', LAUNCHER, agents)
            self.assertNotIn('{{', text, agents)
            for a, name in self.NAMES.items():
                self.assertEqual(name in text, a in agents, (agents, name))
            head = text.split('---\n')[1]
            for a, name in self.NAMES.items():
                self.assertEqual(name in head, a in agents, (agents, name, 'description'))

    def test_the_agent_flag_lists_the_enabled_ids_and_is_left_out_for_one_agent(self):
        for agents in self.combos():
            text = skills.render('agent-sessions', LAUNCHER, agents)
            if len(agents) == 1:
                self.assertNotIn('--agent', text, agents)
                self.assertNotIn("own agent", text, agents)
            else:
                self.assertEqual(re.findall(r'--agent ([a-z|]+)\]', text), ['|'.join(agents)] * 2, agents)

    def test_the_notes_appear_only_with_their_agent(self):
        for agents in self.combos():
            text = skills.render('agent-sessions', LAUNCHER, agents)
            self.assertEqual('--remote-control' in text, 'claude' in agents, agents)
            self.assertEqual('Remote Control URL' in text, 'claude' in agents, agents)
            self.assertEqual('cannot be named at launch' in text, 'codex' in agents, agents)
            self.assertEqual('recorded only after its first message' in text,
                             'codex' in agents or 'opencode' in agents, agents)
            self.assertEqual('OpenCode has no usage windows' in text, 'opencode' in agents, agents)

    def test_stats_is_offered_only_where_an_agent_has_windows(self):
        for agents in self.combos():
            text = skills.render('agent-sessions', LAUNCHER, agents)
            windows = 'claude' in agents or 'codex' in agents
            self.assertEqual('" stats' in text, windows, agents)
            self.assertEqual('5-hour' in text, windows, agents)
            self.assertEqual('per agent' in text, windows and len(agents) > 1, agents)
        self.assertIn('tokens, cost and tools', skills.render('agent-sessions', LAUNCHER, ['opencode']))

    def test_the_late_agents_are_named_as_they_are_enabled(self):
        self.assertIn('With Codex the session', skills.render('agent-sessions', LAUNCHER, ['claude', 'codex']))
        self.assertIn('With Codex or OpenCode the', skills.render('agent-sessions', LAUNCHER, ['codex', 'opencode']))
        self.assertIn('With OpenCode the', skills.render('agent-sessions', LAUNCHER, ['claude', 'opencode']))

    def test_every_command_in_every_text_exists(self):
        for agents in self.combos():
            for cmd in re.findall(r'"%s" (\w+)' % re.escape(LAUNCHER), skills.render('agent-sessions', LAUNCHER, agents)):
                self.assertIn(cmd, SUBCOMMANDS)

    def test_no_agents_given_renders_for_all_three(self):
        self.assertEqual(skills.render('agent-sessions', LAUNCHER), skills.render('agent-sessions', LAUNCHER, ['claude', 'codex', 'opencode']))


class TestInstall(SkillsTestCase):
    def test_installs_into_the_folders_of_the_enabled_agents_only(self):
        status, changes = skills.install(self.vault, ['claude', 'codex'], LAUNCHER)
        self.assertEqual(status, skills.INSTALLED)
        self.assertEqual(len(changes), len(skill_files(CLAUDE)) + len(skill_files(CODEX)))
        self.assertEqual(self.files(), sorted(skill_files(CLAUDE) + skill_files(CODEX)))

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
        self.assertEqual(len(changes), 1)   # only the file that names the launcher
        self.assertIn('/other/agent-sessions', read(self.path(CLAUDE, 'agent-sessions', 'SKILL.md')))

    def test_disabling_an_agent_takes_its_copies_away(self):
        skills.install(self.vault, ['claude', 'codex'], LAUNCHER)
        skills.install(self.vault, ['claude'], LAUNCHER)
        self.assertEqual(self.files(), sorted(skill_files(CLAUDE)))
        self.assertFalse(os.path.exists(self.path('.agents')))

    def test_a_changed_set_rewrites_every_installed_copy(self):
        skills.install(self.vault, ['claude', 'codex', 'opencode'], LAUNCHER)
        for base in (CLAUDE, CODEX):
            text = read(self.path(base, 'agent-sessions', 'SKILL.md'))
            self.assertIn('OpenCode', text)
        status, changes = skills.install(self.vault, ['claude', 'codex'], LAUNCHER)
        self.assertEqual(status, skills.UPDATED)
        self.assertEqual(len(changes), 2)   # the agent-sessions skill in each folder; the help text names no agent set
        for base in (CLAUDE, CODEX):
            text = read(self.path(base, 'agent-sessions', 'SKILL.md'))
            self.assertNotIn('OpenCode', text)
            self.assertIn('Codex', text)
        self.assertEqual(skills.install(self.vault, ['claude', 'codex'], LAUNCHER)[0], skills.UNCHANGED)
        status, _ = skills.install(self.vault, ['claude'], LAUNCHER)
        self.assertEqual(status, skills.UPDATED)
        self.assertNotIn('Codex', read(self.path(CLAUDE, 'agent-sessions', 'SKILL.md')))
        self.assertFalse(os.path.exists(self.path('.agents')))

    def test_an_unchanged_copy_is_not_rewritten_when_only_the_other_changes(self):
        skills.install(self.vault, ['claude', 'codex'], LAUNCHER)
        path = self.path(CLAUDE, 'agent-sessions', 'SKILL.md')
        os.utime(path, (1, 1))
        skills.install(self.vault, ['claude', 'codex'], LAUNCHER)
        self.assertEqual(os.stat(path).st_mtime, 1)

    def test_opencode_alone_moves_to_its_own_folder(self):
        skills.install(self.vault, ['claude'], LAUNCHER)
        skills.install(self.vault, ['opencode'], LAUNCHER)
        self.assertEqual(self.files(), sorted(skill_files(OPENCODE)))

    def test_a_skill_without_the_marker_is_never_overwritten_or_removed(self):
        mine = self.path(CLAUDE, 'agent-sessions', 'SKILL.md')
        os.makedirs(os.path.dirname(mine))
        with open(mine, 'w') as f:
            f.write('my own skill\n')
        status, changes = skills.install(self.vault, ['claude'], LAUNCHER)
        self.assertEqual(status, skills.FOREIGN)
        self.assertTrue(any(mine in c for c in changes))
        self.assertEqual(read(mine), 'my own skill\n')
        skills.remove(self.vault)
        self.assertEqual(read(mine), 'my own skill\n')
        skills.install(self.vault, ['codex'], LAUNCHER)   # moving away from the Claude folder
        self.assertEqual(read(mine), 'my own skill\n')

    def write_legacy(self, base, name, managed=True, policy=False):
        path = self.path(base, name, 'SKILL.md')
        os.makedirs(os.path.dirname(path))
        with open(path, 'w') as f:
            f.write(('%s\n' % skills.MARKER if managed else '') + 'old\n')
        if policy:
            yaml = self.path(base, name, 'agents', 'openai.yaml')
            os.makedirs(os.path.dirname(yaml))
            with open(yaml, 'w') as f:
                f.write(skills.YAML_MARKER + '\npolicy:\n  allow_implicit_invocation: false\n')
        return path

    def test_install_removes_our_three_old_skills_from_every_folder(self):
        for base in (CLAUDE, CODEX, OPENCODE):
            for name in skills.LEGACY_SKILL_NAMES:
                self.write_legacy(base, name, policy=(base == CODEX and name == 'agent-sessions-new'))
        status, _ = skills.install(self.vault, ['claude'], LAUNCHER)
        self.assertEqual(status, skills.INSTALLED)
        self.assertEqual(self.files(), sorted(skill_files(CLAUDE)))

    def test_an_old_skill_without_the_marker_is_left_alone(self):
        mine = self.write_legacy(CLAUDE, 'agent-sessions-new', managed=False)
        skills.install(self.vault, ['claude'], LAUNCHER)
        self.assertEqual(read(mine), 'old\n')

    def test_a_foreign_policy_file_of_an_old_skill_is_left_alone(self):
        self.write_legacy(CODEX, 'agent-sessions-new')
        policy = self.path(CODEX, 'agent-sessions-new', 'agents', 'openai.yaml')
        os.makedirs(os.path.dirname(policy))
        with open(policy, 'w') as f:
            f.write('policy: mine\n')
        skills.install(self.vault, ['codex'], LAUNCHER)
        self.assertEqual(read(policy), 'policy: mine\n')

    def test_remove_takes_the_old_skills_too(self):
        self.write_legacy(CLAUDE, 'agent-sessions-info')
        skills.remove(self.vault)
        self.assertEqual(os.listdir(self.vault), [])

    def test_install_creates_missing_copies_and_rewrites_a_changed_launcher(self):
        self.assertEqual(skills.install(self.vault, ['claude'], LAUNCHER)[0], skills.INSTALLED)
        self.assertEqual(skills.install(self.vault, ['claude'], LAUNCHER)[0], skills.UNCHANGED)
        status, _ = skills.install(self.vault, ['claude'], '/other/agent-sessions')
        self.assertEqual(status, skills.UPDATED)
        self.assertIn('/other/', read(self.path(CLAUDE, 'agent-sessions', 'SKILL.md')))
        os.unlink(self.path(CLAUDE, 'agent-sessions', 'SKILL.md'))
        self.assertEqual(skills.install(self.vault, ['claude'], LAUNCHER)[0], skills.INSTALLED)
        self.assertTrue(os.path.exists(self.path(CLAUDE, 'agent-sessions', 'SKILL.md')))

    def test_an_unchanged_install_does_not_touch_the_file(self):
        skills.install(self.vault, ['claude'], LAUNCHER)
        path = self.path(CLAUDE, 'agent-sessions', 'SKILL.md')
        os.utime(path, (1, 1))
        skills.install(self.vault, ['claude'], LAUNCHER)
        self.assertEqual(os.stat(path).st_mtime, 1)

    def test_dry_run_writes_nothing(self):
        status, changes = skills.install(self.vault, ['claude'], LAUNCHER, dry_run=True)
        self.assertEqual((status, len(changes)), (skills.INSTALLED, len(skill_files(CLAUDE))))
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
        self.assertEqual(len(changes), len(skill_files(CLAUDE)) + len(skill_files(CODEX)))
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
        extra = self.path(CLAUDE, 'agent-sessions', 'notes.txt')
        with open(extra, 'w') as f:
            f.write('n')
        skills.remove(self.vault)
        self.assertEqual(self.files(), ['%s/agent-sessions/notes.txt' % CLAUDE])

    def test_nothing_to_remove_touches_nothing(self):
        os.makedirs(self.path(CLAUDE))
        self.assertEqual(skills.remove(self.vault), [])
        self.assertTrue(os.path.isdir(self.path(CLAUDE)))


class TestHelpSkill(SkillsTestCase):
    HELP = 'agent-sessions-help'
    # UI strings the reference quotes; its text must keep matching the plugin's English and Japanese locales.
    LABEL_KEYS = (
        'action.openSidePanel', 'action.newSession', 'action.sessionManager', 'action.insertNoteAt',
        'action.organize', 'action.rescan', 'action.openSettings', 'action.rename', 'action.moveToCategory',
        'action.compact', 'action.archive', 'action.unarchive', 'action.showArchived', 'action.endSession',
        'action.restartSession', 'action.usage', 'action.copyId', 'action.prevInstruction',
        'action.nextInstruction', 'action.lastResponse', 'action.installBackend', 'action.reinstall',
        'action.uninstallBackend', 'action.checkAgain', 'action.showWelcome', 'action.continueWelcome',
        'action.skip', 'action.resume', 'action.startFresh', 'action.reconnect',
        'settings.backend.name', 'settings.agentSessionsPath.name', 'settings.submitKey.name',
        'settings.editorKey.name', 'settings.language.name', 'settings.notifyOnIdle.name',
        'settings.recentCount.name', 'settings.scrollback.name', 'settings.onboardingOnUpdate.name',
        'settings.onboardingImages.name', 'settings.agents.path.name', 'settings.agents.env.name',
        'settings.agents.detect.name', 'settings.agents.launchVia.name', 'settings.agents.ollamaModel.name',
        'settings.display.heading', 'settings.input.heading', 'settings.other.heading', 'settings.agents.heading',
        'settings.font.name', 'settings.fontSize.name', 'settings.padding.name', 'settings.onboarding.name',
        'section.openTabs', 'section.running', 'section.recent', 'group.other', 'toolbar.filterPlaceholder',
        'toolbar.filterByStatus', 'table.updated', 'table.model', 'table.effort', 'table.folder',
        'status.working', 'status.runningShell', 'status.asking', 'status.waiting', 'status.idle',
        'status.detached', 'status.exited', 'status.error', 'status.connecting', 'status.editing',
        'status.group.all', 'status.group.needsInput', 'status.group.needsReview', 'status.group.running',
        'status.group.done', 'status.group.archived', 'organize.suggest', 'organize.suggestAgain',
        'organize.resuggest', 'organize.apply', 'organize.showLog', 'organize.onlyIncomplete',
        'modal.newSession.nameField', 'modal.newSession.agentField', 'install.winget.python',
        'install.winget.claude', 'install.skills', 'settings.agents.unsupportedOnPlatform',
    )

    @staticmethod
    def locale(code):
        path = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
                            'plugin', 'src', 'i18n', 'locales', code + '.ts')
        pairs = re.findall(r'^\t"([\w.]+)":\s*"((?:[^"\\]|\\.)*)",?$', read(path), re.M)
        return {k: v.replace('\\"', '"') for k, v in pairs}

    def test_the_skill_is_a_short_skill_md_and_a_reference_next_to_it(self):
        self.assertEqual(skills.template_files(self.HELP), ['SKILL.md', 'reference.md'])
        text = skills.render(self.HELP, LAUNCHER)
        self.assertLess(len(text.splitlines()), 40)
        self.assertIn('`reference.md`', text)
        self.assertIn('agent-sessions` skill', text)
        head = text.split('---\n')[1]
        description = head.split('description: ', 1)[1].split('\n')[0]
        for word in ('side panel', 'Session Manager', 'built-in editor', 'in any language'):
            self.assertIn(word, text)
        self.assertIn('Use when the user asks how to', description)

    def test_every_file_carries_the_marker_and_no_placeholder_is_left(self):
        for f in skills.template_files(self.HELP):
            text = skills.render(self.HELP, LAUNCHER, file=f)
            self.assertIn(skills.MARKER, text, f)
            self.assertNotIn('{{', text, f)

    def test_the_reference_is_the_same_whichever_agents_are_enabled(self):
        for agents in (['claude'], ['codex'], ['opencode'], ['claude', 'codex', 'opencode']):
            self.assertEqual(skills.render(self.HELP, LAUNCHER, agents, 'reference.md'),
                             skills.render(self.HELP, LAUNCHER, file='reference.md'))

    def test_the_reference_quotes_the_plugins_labels_in_both_languages(self):
        en, ja = self.locale('en'), self.locale('ja')
        self.assertGreater(len(en), 300)
        text = skills.render(self.HELP, LAUNCHER, file='reference.md')
        for key in self.LABEL_KEYS:
            for code, table in (('en', en), ('ja', ja)):
                label = re.sub(r'\s*[（(].*$|…$|\s*\{.*$', '', table[key]).strip().rstrip('.。')
                if label:
                    self.assertTrue(label in text, '%s (%s): %r' % (key, code, label))

    def test_the_reference_names_the_unsupported_setups(self):
        text = skills.render(self.HELP, LAUNCHER, file='reference.md')
        for phrase in ('WSL1', 'WSL2', 'WSLg', 'Codex and OpenCode show', 'not supported'):
            self.assertIn(phrase, text)

    def test_the_reference_is_installed_next_to_skill_md_in_every_folder(self):
        skills.install(self.vault, ['claude', 'codex'], LAUNCHER)
        for base in (CLAUDE, CODEX):
            folder = self.path(base, self.HELP)
            self.assertEqual(sorted(os.listdir(folder)), ['SKILL.md', 'reference.md'])
            self.assertEqual(read(os.path.join(folder, 'reference.md')),
                             skills.render(self.HELP, LAUNCHER, ['claude', 'codex'], 'reference.md'))

    def test_a_reference_without_the_marker_is_never_overwritten_or_removed(self):
        skills.install(self.vault, ['claude'], LAUNCHER)
        ref = self.path(CLAUDE, self.HELP, 'reference.md')
        with open(ref, 'w') as f:
            f.write('my notes\n')
        status, changes = skills.install(self.vault, ['claude'], LAUNCHER)
        self.assertEqual(status, skills.FOREIGN)
        self.assertTrue(any(ref in c for c in changes))
        skills.remove(self.vault)
        self.assertEqual(read(ref), 'my notes\n')
        self.assertEqual(self.files(), ['%s/%s/reference.md' % (CLAUDE, self.HELP)])

    def test_a_foreign_help_skill_does_not_hold_back_the_other_files(self):
        mine = self.path(CLAUDE, self.HELP, 'SKILL.md')
        os.makedirs(os.path.dirname(mine))
        with open(mine, 'w') as f:
            f.write('my own skill\n')
        status, _ = skills.install(self.vault, ['claude'], LAUNCHER)
        self.assertEqual(status, skills.FOREIGN)
        self.assertEqual(read(mine), 'my own skill\n')
        self.assertTrue(os.path.exists(self.path(CLAUDE, 'agent-sessions', 'SKILL.md')))

    def test_an_edited_or_deleted_reference_is_put_back(self):
        skills.install(self.vault, ['claude'], LAUNCHER)
        ref = self.path(CLAUDE, self.HELP, 'reference.md')
        with open(ref, 'a') as f:
            f.write('\nedited\n')
        status, changes = skills.install(self.vault, ['claude'], LAUNCHER)
        self.assertEqual((status, len(changes)), (skills.UPDATED, 1))
        self.assertNotIn('edited', read(ref))
        os.unlink(ref)
        status, changes = skills.install(self.vault, ['claude'], LAUNCHER)
        self.assertEqual((status, len(changes)), (skills.INSTALLED, 1))
        self.assertEqual(skills.install(self.vault, ['claude'], LAUNCHER), (skills.UNCHANGED, []))

    def test_moving_to_another_folder_takes_the_reference_along(self):
        skills.install(self.vault, ['claude'], LAUNCHER)
        skills.install(self.vault, ['opencode'], LAUNCHER)
        self.assertEqual(self.files(), sorted(skill_files(OPENCODE)))
        self.assertFalse(os.path.exists(self.path('.claude')))

    def test_a_file_someone_added_next_to_the_reference_stays(self):
        skills.install(self.vault, ['claude'], LAUNCHER)
        extra = self.path(CLAUDE, self.HELP, 'notes.txt')
        with open(extra, 'w') as f:
            f.write('n')
        skills.remove(self.vault)
        self.assertEqual(self.files(), ['%s/%s/notes.txt' % (CLAUDE, self.HELP)])


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
        self.assertIn('"%s"' % LAUNCHER, read(self.path(CLAUDE, 'agent-sessions', 'SKILL.md')))
        rc, out, _ = self.run_setup('--skills', '--vault', self.vault, '--agents', 'claude', '--command', LAUNCHER)
        self.assertEqual(out.strip().splitlines()[-1], 'agent-skills: unchanged')

    def test_the_agents_come_from_the_enabled_ones_when_not_given(self):
        with mock.patch.dict(os.environ, {'AGENT_SESSIONS_AGENTS': 'codex'}):
            self.run_setup('--skills', '--vault', self.vault)
        self.assertTrue(os.path.exists(self.path(CODEX, 'agent-sessions', 'SKILL.md')))
        self.assertFalse(os.path.exists(self.path('.claude')))

    def test_the_vault_falls_back_to_the_configured_one(self):
        with mock.patch.object(config, 'VAULT', self.vault), \
                mock.patch.dict(os.environ, {'AGENT_SESSIONS_AGENTS': 'claude'}):
            self.run_setup('--skills')
        self.assertTrue(os.path.exists(self.path(CLAUDE, 'agent-sessions', 'SKILL.md')))

    def test_without_any_vault_it_fails_in_words(self):
        with mock.patch.object(config, 'VAULT', None):
            rc, _, err = self.run_setup('--skills')
        self.assertEqual(rc, 1)
        self.assertIn('--vault', err)

    def test_update_only_flag_does_not_limit_the_skills(self):
        rc, out, _ = self.run_setup('--skills', '--update-only', '--vault', self.vault, '--agents', 'claude')
        self.assertEqual(rc, 0)
        self.assertEqual(out.strip().splitlines()[-1], 'agent-skills: installed')
        self.assertTrue(os.path.exists(self.path(CLAUDE, 'agent-sessions', 'SKILL.md')))

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


class WindowsLauncherTest(unittest.TestCase):
    def test_a_cmd_launcher_is_written_unquoted_with_forward_slashes(self) -> None:
        text = skills.render('agent-sessions', r'C:\Users\a\AppData\Local\agent-sessions\bin\agent-sessions.cmd', ['claude'])
        self.assertIn('C:/Users/a/AppData/Local/agent-sessions/bin/agent-sessions.cmd stats', text)
        self.assertNotIn('"C:', text)


class DefaultLauncherTest(unittest.TestCase):
    def test_a_program_on_another_drive_is_named_by_its_path(self) -> None:
        with mock.patch.object(skills.os.path, 'relpath', side_effect=ValueError('path is on mount D:')), \
                mock.patch.object(skills.sys, 'platform', 'linux'):
            launcher = skills.default_launcher()
        self.assertTrue(launcher.endswith(os.path.join('bin', 'agent-sessions')))
        self.assertFalse(launcher.startswith('$HOME'))

    def test_windows_names_the_cmd_launcher(self) -> None:
        with mock.patch.object(skills.sys, 'platform', 'win32'), \
                mock.patch.object(skills.os.path, 'exists', return_value=True):
            self.assertTrue(skills.default_launcher().endswith('agent-sessions.cmd'))
