"""Token efficiency analysis (`agent-sessions json efficiency`).

Reads the local transcripts, turns them into numbers (`normalize`), groups turns into
tasks (`tasks`), finds where tokens could be saved (`detect`, `impact`), and picks the
masked excerpts a model may later read (`excerpt`). Every decision is made from
structural signals only -- times, lengths, tool kinds and targets, interruptions,
repeated edits -- never from the words a person wrote, so the result is the same in
any language. Judging meaning (was it a correction, is the request vague) is left to
the model that reads the excerpts, on the plugin's side.
"""
