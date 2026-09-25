"""Shared helpers for building synthetic Codex rollout fixtures.

Record shapes here mirror real `~/.codex/sessions/**/*.jsonl` data inspected
2026-09-25 (session_meta/turn_context/response_item/event_msg/token_usage_record;
see plan/段9-Codex対応.md and agentsessions/agents/codex/rollout.py's docstring) --
but every value (ids, cwd, message text) is synthetic, not copied from any real
session. `plan/reports/T-95.md` notes this as a scope tradeoff: the contract asked
for fixtures built by anonymizing real data, but hand-written synthetic fixtures
covering the same shapes were faster to get right and carry zero risk of a
real path/message slipping through an imperfect anonymizer.
"""
import json
import os


def write_rollout(path: str, records: list) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8') as f:
        for r in records:
            f.write(json.dumps(r, ensure_ascii=False) + '\n')


def rollout_path(home: str, thread_id: str, when: str = '2026/09/24',
                  ts: str = '2026-09-24T01-30-30') -> str:
    return os.path.join(home, 'sessions', *when.split('/'), 'rollout-%s-%s.jsonl' % (ts, thread_id))


def session_meta(thread_id: str, cwd: str, source: str = 'cli',
                  ts: str = '2026-09-24T01:30:30.000Z') -> dict:
    return {'timestamp': ts, 'type': 'session_meta',
            'payload': {'session_id': thread_id, 'cwd': cwd, 'source': source,
                        'originator': 'codex_cli_rs', 'cli_version': '0.999.0'}}


def turn_context(model: str = 'gpt-5.6-terra', effort: str = 'medium',
                  ts: str = '2026-09-24T01:30:30.100Z') -> dict:
    return {'timestamp': ts, 'type': 'turn_context',
            'payload': {'model': model, 'effort': effort}}


def turn_context_old_format(model: str = 'gpt-5.6-terra', reasoning_effort: str = 'medium',
                             ts: str = '2026-09-24T01:30:30.100Z') -> dict:
    """An older rollout's `turn_context` -- no top-level `effort`, only nested
    under `collaboration_mode.settings.reasoning_effort` (T-107)."""
    return {'timestamp': ts, 'type': 'turn_context',
            'payload': {'model': model,
                        'collaboration_mode': {'settings': {'reasoning_effort': reasoning_effort}}}}


def user_message(text: str, ts: str) -> dict:
    """A `response_item` role=user message -- Codex's own reconstructed prompt
    for the model, which real data shows mixes in injected context (AGENTS.md
    instructions, `<environment_context>`, ...) ahead of a real one. Ranked
    lowest of the three sources `read_head`/`read_detail` try (T-101) -- a
    last resort for CLI versions with neither of the other two -- so a fixture
    using only this one, filtered, should still surface a real (non-injected)
    message; use `event_user_message`/`item_completed_user_message` for a
    higher-priority fixture."""
    return {'timestamp': ts, 'type': 'response_item',
            'payload': {'type': 'message', 'role': 'user',
                        'content': [{'type': 'input_text', 'text': text}]}}


def event_user_message(text: str, ts: str) -> dict:
    """An `event_msg.user_message` -- the literal text the user typed, on Codex
    CLI versions that write this event (never mixed with injected context in
    real data). See `agents.codex.rollout`'s module docstring for the
    version-dependent split with `item_completed_user_message`, below."""
    return {'timestamp': ts, 'type': 'event_msg',
            'payload': {'type': 'user_message', 'message': text}}


def item_completed_user_message(text: str, ts: str, thread_id: str = 'thread-id',
                                 turn_id: str = 'turn-id') -> dict:
    """An `event_msg.item_completed` with `item.type == 'UserMessage'` -- the
    newer Codex CLI versions' (e.g. 0.156.1) equivalent of `event_user_message`
    (T-101: these versions don't write `user_message` events at all, only
    this). Content blocks are typed `'text'`, not `'input_text'`/`'output_text'`
    -- see `rollout.text_of`."""
    return {'timestamp': ts, 'type': 'event_msg',
            'payload': {'type': 'item_completed', 'thread_id': thread_id, 'turn_id': turn_id,
                        'item': {'type': 'UserMessage', 'id': 'item-id',
                                 'content': [{'type': 'text', 'text': text, 'text_elements': []}]}}}


def assistant_message(text: str, ts: str) -> dict:
    return {'timestamp': ts, 'type': 'response_item',
            'payload': {'type': 'message', 'role': 'assistant',
                        'content': [{'type': 'output_text', 'text': text}]}}


def function_call(name: str, ts: str) -> dict:
    return {'timestamp': ts, 'type': 'response_item',
            'payload': {'type': 'function_call', 'name': name}}


def event(payload_type: str, ts: str, **extra) -> dict:
    return {'timestamp': ts, 'type': 'event_msg', 'payload': {'type': payload_type, **extra}}


def token_count(total: dict, ts: str, rate_limits: dict = None) -> dict:
    payload = {'type': 'token_count', 'info': {'total_token_usage': total}}
    if rate_limits is not None:
        payload['rate_limits'] = rate_limits
    return {'timestamp': ts, 'type': 'event_msg', 'payload': payload}
