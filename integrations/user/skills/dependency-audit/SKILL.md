---
name: dependency-audit
description: "Check the need, compatibility and maintenance cost of a proposed new dependency."
---

# Dependency audit

Before adding a package, check whether the runtime or an existing dependency already covers the requirement. Use official documentation for the installed versions and verify compatibility, licence obligations and the actual use site.

Prefer the smallest maintained option that meets the requirement. State why the dependency is necessary and which runtime, build or deployment behavior it affects. Do not create a separate worker or approval step for a routine decision already inside the user's scope. Do not install anything during a read-only audit.
