# M8 npm scope migration

The publishing account vormir-techies owns the npm organization vormirtech.
The public SDK package name changes from @vormir/mavio to @vormirtech/mavio.
The release version remains 0.0.3.

Active imports, workspace commands, examples, and developer instructions
use the new name. Private docs/playground workspace names remain unchanged.

Historical M0/M7 records and existing archive evidence retain their original
package identities. They must not be interpreted as verification of the renamed archive.

The previously reviewed SDK archive is superseded for publication.
A new archive, installed-consumer checks, and CI are required.

The published Browser engine binaries, source archive, and notices are unchanged.
Their historical SDK-name references will be clarified in release guidance.

The applicability of release-scoped owner dispositions must be explicitly
recorded for the renamed 0.0.3 package before publication approval.
No scope change extends those dispositions to a later release.

npm publication remains pending.
