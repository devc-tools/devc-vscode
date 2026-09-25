# Tree Design

Icons

- <H> = host icon
- <C> = container icon

1. Initial state shows empty Workspace Sessions node and Other Sessions node (to be defined later). Workspace Sessions node has a + action.

```
Workspace Sessions                  +

> Other Sessions
```

2. User clicks + action. Environment picker is shown. It shows host item + a container item for any folder in the workspace

```
<H> folder-aaa
<C> folder-aaa
<C> folder-bbb
```

3. User selects environment. Agent picker is shown.

```
Claude
Copilot
Pi
```

4. User selects agent. If host env was selected in first picker, local herdr session for the primary workspace folder is attached and a new agent added to it

5. Hierarchy of environment nodes with agent children get added to the tree under Workspace Sessions. Environment nodes include + buttons that just open the agent picker to add agents. Other Sessions shows similar nodes for other workspaces. All agent nodes are selectable and navigate to respective window / session. Other Sessions section doesn't have + buttons to add things.

```
Workspace Sessions             +
  <H> folder-aaa               +
    ○ Some task - claude
    ○ Task B. - pi
  <C> folder-aaa               +
    ○ Another task - claude
    ○ Some other task - claude
  <C> folder-bbb               +
    ○ Another thing - claude
Other Sessions
  <H> wksp-xxx
    ○ Xxx task - claude
  <C> wksp-xxx
    ○ Xxx task 2 - claude
  <C> wksp-yyy
    ○ Yyy thing - claude
```
