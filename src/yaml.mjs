// Minimal YAML subset for herdr-worktree.yaml: root mapping, nested mappings,
// sequences of scalars, plain/quoted scalars, comments, blank lines. The config
// schema is tiny on purpose — staying dependency-free keeps `herdr plugin link`
// instant. Flow collections, anchors, block scalars, and multi-doc input are
// rejected with a line number instead of being half-understood.

export class YamlError extends Error {
  constructor(message, line) {
    super(line != null ? `${message} (line ${line + 1})` : message)
    this.name = 'YamlError'
    this.line = line
  }
}

// Cut a '#' comment that is not inside quotes; '#' glued to text (URLs etc.) stays.
function stripComment(line) {
  let quote = null
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quote) {
      if (ch === quote) quote = null
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i)
    }
  }
  return line
}

function tokenize(text) {
  const nodes = []
  const rawLines = text.split(/\r?\n/)
  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i]
    if (/^[ ]*\t/.test(raw)) throw new YamlError('tabs are not allowed for indentation', i)
    const content = stripComment(raw).trim()
    if (content === '' || content === '---') continue
    nodes.push({ indent: raw.match(/^ */)[0].length, content, line: i })
  }
  return nodes
}

function parseScalar(raw, line) {
  const s = raw.trim()
  if (s === '') throw new YamlError('empty value', line)
  if (s.startsWith('[') || s.startsWith('{')) {
    throw new YamlError('flow collections are not supported, use block style', line)
  }
  if (s.startsWith('"')) {
    if (s.length < 2 || !s.endsWith('"')) throw new YamlError('unterminated double-quoted string', line)
    return s.slice(1, -1).replace(/\\(.)/g, (_, c) => (c === 'n' ? '\n' : c === 't' ? '\t' : c))
  }
  if (s.startsWith("'")) {
    if (s.length < 2 || !s.endsWith("'")) throw new YamlError('unterminated single-quoted string', line)
    return s.slice(1, -1).replace(/''/g, "'")
  }
  if (s === 'true') return true
  if (s === 'false') return false
  if (s === 'null' || s === '~') return null
  if (/^-?\d+$/.test(s)) return Number(s)
  if (/^-?\d+\.\d+$/.test(s)) return Number(s)
  return s
}

export function parseYaml(text) {
  const nodes = tokenize(text)
  let pos = 0

  function parseBlock(indent) {
    const first = nodes[pos]
    if (first.indent !== indent) {
      throw new YamlError(`unexpected indentation (expected ${indent} spaces)`, first.line)
    }
    return first.content.startsWith('- ') ? parseSequence(indent) : parseMapping(indent)
  }

  function parseSequence(indent) {
    const out = []
    while (pos < nodes.length && nodes[pos].indent === indent && nodes[pos].content.startsWith('- ')) {
      const node = nodes[pos]
      const item = node.content.slice(2).trim()
      pos++
      if (item === '') {
        if (pos < nodes.length && nodes[pos].indent > indent) out.push(parseBlock(nodes[pos].indent))
        else out.push(null)
      } else {
        if (pos < nodes.length && nodes[pos].indent > indent) {
          throw new YamlError('nested blocks under a scalar list item are not supported', node.line)
        }
        out.push(parseScalar(item, node.line))
      }
    }
    return out
  }

  function parseMapping(indent) {
    const obj = {}
    while (pos < nodes.length && nodes[pos].indent === indent) {
      const node = nodes[pos]
      const match = node.content.match(/^("[^"]*"|'[^']*'|[^:#]+):(?:[ ]+(.*))?$/)
      if (!match) throw new YamlError(`expected "key: value", got "${node.content}"`, node.line)
      const key = parseScalar(match[1], node.line)
      const rest = (match[2] ?? '').trim()
      pos++
      if (rest === '') {
        if (pos < nodes.length && nodes[pos].indent > indent) obj[key] = parseBlock(nodes[pos].indent)
        else obj[key] = null
      } else {
        obj[key] = parseScalar(rest, node.line)
      }
    }
    return obj
  }

  if (nodes.length === 0) return null
  return parseBlock(nodes[0].indent)
}
