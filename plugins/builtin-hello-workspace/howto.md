# builtin-hello-workspace - how-to topics (#192).
#
# Sections are delimited by `--- id: <topic-id>`; every id must appear in this
# plugin's `howtoIndex`. Anything before the first delimiter is ignored.

--- id: hello-workspace
A deliberately tiny **workspace tab**, enabled from Edit ▸ Plugins, that types a note which persists with the project and counts the rows in the dataset.

It exists to be read rather than used. If you are writing a workspace plugin, this is the smallest complete example of the two things one needs to do: keep state that saves and reloads with the project, and read the active dataset.

Nothing else depends on it, and leaving it off costs nothing.
