# Build inside the appetite

The pitch is the brief. Build what it describes and no more.

**Build.** Write `build/<pitch id>/change.md`: what was built, how it works, and
how it was checked, in plain terms. Stay inside the pitch's no-gos; a
reviewer reads the change against them and against the rabbit holes.

**Scope.** Write `build/<pitch id>/scope.md`: what was cut or simplified to fit the
appetite, one line each, and what that costs the user. An empty file is
wrong; something is always cut.

A check fails the build if the change names a no-go or the scope file is
empty. The stage's time limit is the appetite.
