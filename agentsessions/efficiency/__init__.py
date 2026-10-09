"""Token efficiency analysis (`agent-sessions json efficiency`).

Reads the local transcripts, turns them into numbers (`normalize`), groups turns into
tasks (`tasks`), finds where tokens could be saved (`detect`, `impact`), and builds the
masked digest a model may later read (`digest`, masked by `excerpt`). The statistics are
made from structural signals only -- times, lengths, tool kinds and targets,
interruptions, repeated edits -- never from the words a person wrote, so they are the
same in any language. Judging the conversations (which checks have an issue, in which
tasks) is left to the model that reads the digest, on the plugin's side; the statistics'
hits go along as hints.
"""
