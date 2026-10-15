"""The rules a session's name and category meet, as the plugin's **Suggest name and category** checks
them (`NAME_LIMIT`, `CATEGORY_LIMIT`, `checkSuggestion` and `categoryProfiles` in
plugin/src/sessions/organize.ts), for `agent-sessions suggest-name`. tests/sessions/test_naming.py
compares the limits and patterns with the TypeScript.

A full name is `Category: Name` (`model.split_name`). Pure."""
import re
import unicodedata
from typing import Any, Dict, List, Optional, Sequence

from .model import SEP, split_name

NAME_LIMIT = {'cjkChars': 20, 'words': 5, 'latinChars': 32}
CATEGORY_LIMIT = {'cjkChars': 12, 'words': 3, 'latinChars': 24}

CATEGORY_LIST_CAP = 40
EXAMPLES_PER_CATEGORY = 3
EXAMPLE_MAX = 40

CJK = re.compile('[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]')
# Kinds of task that are not categories, unless the user already has a category by that name (the
# Japanese words: investigation, research, debugging, documents, bug fix, question, chat, other).
TASK_TYPE_CATEGORY = re.compile(
    '^(?:debug(?:ging)?|research|docs?|documentation|bug ?fix(?:es)?|fix(?:es)?|refactor(?:ing)?|investigation|questions?|chat|misc|other|'
    '調査|リサーチ|デバッグ|ドキュメント|バグ修正|質問|雑談|その他)$',
    re.IGNORECASE)
# A name that ends like a sentence (Japanese verb or polite endings, a question mark).
SENTENCE_ENDING = re.compile(
    '(?:する|した|して|します|しました|ください|です|ます|でした|ました|[?？])$')

ISSUES = {
    'nameTooLong': 'the name is too long (at most %d characters in Japanese, Chinese or Korean; %d words or %d '
                   'characters otherwise)' % (NAME_LIMIT['cjkChars'], NAME_LIMIT['words'], NAME_LIMIT['latinChars']),
    'nameIsSentence': 'the name reads as a sentence or verb phrase; make it a noun phrase',
    'nameRepeatsCategory': 'the name repeats the category; leave the category out of the name',
    'nameHasSeparator': 'the name contains "%s", which would split it into a category and a name' % SEP.strip(),
    'categoryTooLong': 'the category is too long (at most %d characters in Japanese, Chinese or Korean; %d words '
                       'otherwise)' % (CATEGORY_LIMIT['cjkChars'], CATEGORY_LIMIT['words']),
    'categoryIsTaskType': 'the category names a kind of task; use a project, client or area, preferably an '
                          'existing category',
    'noCategory': 'no category was given; choose an existing one when the session fits it',
    'noName': 'the name is empty',
}

RULES = (
    'What the two parts are:',
    '- category: the project, client or area the session belongs to, like the existing categories listed '
    '(look at their example names to see the granularity). It is never a kind of task such as Debug, '
    'Research, Docs, Bug fix or Question.',
    '- name: a short noun phrase naming the specific task or topic of the session.',
    'Rules for the category:',
    '- Strongly prefer an existing category, copied exactly. Use it whenever the session belongs to that '
    'project or area, judging by the folder, the conversation and the example names under it.',
    '- Make a new category only when no existing one fits: a short noun for a project, client or area, at '
    'most %d characters in Japanese, Chinese or Korean and at most %d words otherwise, at the same '
    'granularity as the existing ones.' % (CATEGORY_LIMIT['cjkChars'], CATEGORY_LIMIT['words']),
    '- If the current name already has a category before ": " and it fits, keep it.',
    'Rules for the name:',
    '- At most %d characters in Japanese, Chinese or Korean; at most %d words (about %d characters) '
    'otherwise. Shorter is better.' % (NAME_LIMIT['cjkChars'], NAME_LIMIT['words'], NAME_LIMIT['latinChars']),
    '- A noun phrase for the task or topic (for example "Login redirect bug"). No verb endings or '
    'sentences, no questions.',
    '- Do not repeat the category in the name. No quotes, brackets, emoji or colons. No dates unless the '
    'date is the point.',
    '- Write category and name in the language of the conversation.',
    '- If the current name and category are already good, keep them.',
)


def over_limit(text: str, limit: Dict[str, int]) -> bool:
    if CJK.search(text):
        return len(text) > limit['cjkChars']
    return len(text.split()) > limit['words'] or len(text) > limit['latinChars']


def _normalize(category: str) -> str:
    return re.sub(r'\s+', '', unicodedata.normalize('NFKC', category).lower())


def match_existing(category: str, existing: Sequence[str]) -> Optional[str]:
    """The existing category spelled the way `category` is (ignoring case, width and spaces), if any."""
    key = _normalize(category)
    return next((e for e in existing if _normalize(e) == key), None) if key else None


def check(category: str, name: str, existing: Sequence[str]) -> List[str]:
    """What is wrong with `category` and `name` (keys of `ISSUES`), given the existing categories:
    `checkSuggestion`'s checks, plus an empty name and a name holding the separator."""
    issues: List[str] = []
    if not name:
        issues.append('noName')
    else:
        if over_limit(name, NAME_LIMIT):
            issues.append('nameTooLong')
        if SENTENCE_ENDING.search(name):
            issues.append('nameIsSentence')
        if len(category) >= 2 and category.lower() in name.lower():
            issues.append('nameRepeatsCategory')
        if SEP in name:
            issues.append('nameHasSeparator')
    if not category:
        issues.append('noCategory')
    elif not match_existing(category, existing):
        if over_limit(category, CATEGORY_LIMIT):
            issues.append('categoryTooLong')
        if TASK_TYPE_CATEGORY.match(category.strip()):
            issues.append('categoryIsTaskType')
    return issues


def parse(full: str) -> Dict[str, str]:
    """`Category: Name` (or a bare name) split and trimmed."""
    full = ' '.join(full.split())
    category, name = split_name(full)
    return {'category': (category or '').strip(), 'name': name.strip()}


def compose(category: str, name: str, existing: Sequence[str]) -> str:
    """The full name to give: the category spelled as the existing one it matches (`composeName`)."""
    category = match_existing(category, existing) or category.strip()
    name = name.strip()
    return '%s%s%s' % (category, SEP, name) if category and name else name


def _excerpt(text: str, limit: int) -> str:
    flat = ' '.join(text.split())
    return flat[:limit - 1] + '…' if len(flat) > limit else flat


def category_profiles(rows: Sequence[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Each existing category with how many sessions use it and a few of their names, most used first
    (`categoryProfiles`). `rows` are `listing.collect` rows; sub-agent and unnamed ones are skipped."""
    by: Dict[str, List[Dict[str, Any]]] = {}
    for r in rows:
        if r.get('child') or not r.get('named'):
            continue
        category, name = split_name(r['name'])
        if not category:
            continue
        by.setdefault(category, []).append({'last': r.get('last_activity') or 0, 'name': name})
    out = []
    for category, entries in by.items():
        examples: List[str] = []
        for e in sorted(entries, key=lambda e: -e['last']):
            x = _excerpt(e['name'], EXAMPLE_MAX)
            if x not in examples:
                examples.append(x)
        out.append({'category': category, 'sessions': len(entries), 'examples': examples[:EXAMPLES_PER_CATEGORY]})
    out.sort(key=lambda p: (-p['sessions'], p['category']))
    return out[:CATEGORY_LIST_CAP]
