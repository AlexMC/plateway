"""Failures the user can act on; their messages are shown in the UI as written."""


class UserError(ValueError):
    """One short, plain sentence for the person preparing prints."""


BAMBU_MISSING = 'Install Bambu Studio to create print plates.'
