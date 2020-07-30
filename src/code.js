
import { parse } from 'acorn';
import { generate } from 'astring';
import { assert } from './utils.js'


export function transformJS(code, option={}) {
    let result = {
        watchers: [],
        imports: [],
        props: [],
        rootVariables: {},
        rootFunctions: {}
    };
    var ast;
    if(code) {
        code = code.split(/\n/).map(line => {
            let rx = line.match(/^(\s*)\/\/(.*)$/);
            if(!rx) return line;
            let code = rx[2].trim()
            if(code != '!check-stop') return line;
            return rx[1] + '$$_checkStop;';
        }).join('\n');
        ast = parse(code, {sourceType: 'module'});
    } else {
        ast = {
            body: [],
            sourceType: "module",
            type: "Program"
        };
    }

    let rootVariables = result.rootVariables;
    let rootFunctions = result.rootFunctions;
    ast.body.forEach(n => {
        if(n.type == 'FunctionDeclaration') {
            rootFunctions[n.id.name] = true;
        } else if(n.type == 'VariableDeclaration') {
            n.declarations.forEach(i => rootVariables[i.id.name] = true);
        }
    });

    result.onMount = rootFunctions.onMount;
    result.onDestroy = rootFunctions.onDestroy;
    let insertOnDestroy = !(rootFunctions.$onDestroy || rootVariables.$onDestroy);

    const funcTypes = {
        FunctionDeclaration: 1,
        FunctionExpression: 1,
        ArrowFunctionExpression: 1
    }

    function applyBlock() {
        return {
            type: 'ExpressionStatement',
            expression: {
                callee: {
                    type: 'Identifier',
                    name: '$$apply'
                },
                type: 'CallExpression'
            }
        }
    }

    function isInLoop(node) {
        if(!node._parent || node._parent.type != 'CallExpression') return false;
        if(node._parent.callee.type != 'MemberExpression') return false;
        let method = node._parent.callee.property.name;
        return method == 'forEach' || method == 'map' || method == 'filter';
    }

    function isStopOption(node) {
        return node.type == 'ExpressionStatement' && node.expression.type == 'Identifier' && node.expression.name == '$$_checkStop';
    };

    function transformNode(node) {
        if(funcTypes[node.type] && node.body.body && node.body.body.length) {
            if(insertOnDestroy && node._parent.type == 'CallExpression' && node._parent.callee.name == '$onDestroy') return 'stop';
            for(let i=0; i<node.body.body.length; i++) {
                let n = node.body.body[i];
                if(!isStopOption(n)) continue;
                node.body.body[i] = parseExp('$$apply(false)');
                return 'stop';
            }
            if(!isInLoop(node)) {
                node.body.body.unshift(applyBlock());
            }
        } else if(node.type == 'ArrowFunctionExpression') {
            if(insertOnDestroy && node._parent.type == 'CallExpression' && node._parent.callee.name == '$onDestroy') return 'stop';
            if(node.body.type != 'BlockStatement' && !isInLoop(node)) {
                node.body = {
                    type: 'BlockStatement',
                    body: [{
                        type: 'ReturnStatement',
                        argument: node.body
                    }]
                };
                transformNode(node);
            }
        } else if(node.type == 'AwaitExpression') {
            if(node._parent && node._parent._parent && node._parent._parent._parent) {
                if(node._parent.type == 'ExpressionStatement' &&
                    node._parent._parent.type == 'BlockStatement' &&
                    node._parent._parent._parent.type == 'FunctionDeclaration' &&
                    node._parent._parent._parent.async) {
                        let list = node._parent._parent.body;
                        let i = list.indexOf(node._parent);
                        assert(i >= 0);
                        list.splice(i + 1, 0, applyBlock());
                    }
            }
        }
    };

    function walk(node, parent) {
        if(typeof node !== 'object') return;

        node._parent = parent;
        let forParent = parent;
        if(node.type) {
            if(transformNode(node) == 'stop') return;
            forParent = node;
        }
        for(let key in node) {
            let child = node[key];
            if(key == '_parent') continue;
            if(!child || typeof child !== 'object') continue;

            if(Array.isArray(child)) {
                child.forEach(i => walk(i, forParent));
            } else {
                walk(child, forParent);
            }
        }
    };
    walk(ast, null);


    function makeVariable(name) {
        return {
            "type": "VariableDeclaration",
            "declarations": [{
                "type": "VariableDeclarator",
                "id": {
                    "type": "Identifier",
                    "name": name
                },
                "init": null
            }],
            "kind": "var"
        }
    }

    function makeWatch(n) {
        function assertExpression(n) {
            if(n.type == 'Identifier') return;
            if(n.type.endsWith('Expression')) return;
            throw 'Wrong expression';
        };

        if(n.body.type != 'ExpressionStatement') throw 'Error';
        if(n.body.expression.type == 'AssignmentExpression') {
            const ex = n.body.expression;
            if(ex.operator != '=') throw 'Error';
            let target;
            if(ex.left.type == 'Identifier') {
                target = ex.left.name;
                if(!(target in rootVariables)) resultBody.push(makeVariable(target));
            } else if(ex.left.type == 'MemberExpression') {
                target = code.substring(ex.left.start, ex.left.end);
            } else throw 'Error';
            assertExpression(ex.right);
            const exp = code.substring(ex.right.start, ex.right.end);
            result.watchers.push(`$cd.prefix.push(() => {${target} = ${exp};});`);
        } else if(n.body.expression.type == 'SequenceExpression') {
            const ex = n.body.expression.expressions;
            const handler = ex[ex.length - 1];
            if(['ArrowFunctionExpression', "FunctionExpression"].indexOf(handler.type) < 0) throw 'Error function';
            let callback = code.substring(handler.start, handler.end);

            if(ex.length == 2) {
                assertExpression(ex[0]);
                let exp = code.substring(ex[0].start, ex[0].end);
                result.watchers.push(`$watch($cd, () => (${exp}), ${callback});`);
            } else if(ex.length > 2) {
                for(let i = 0;i<ex.length-1;i++) assertExpression(ex[i]);
                let exp = code.substring(ex[0].start, ex[ex.length-2].end);
                result.watchers.push(`$watch($cd, () => [${exp}], ($args) => { (${callback}).apply(null, $args); }, {cmp: $$compareArray});`);
            } else throw 'Error';
        } else throw 'Error';
    }

    let imports = [];
    let resultBody = [];
    let lastPropIndex = null;

    ast.body.forEach(n => {
        if(n.type == 'ImportDeclaration') {
            imports.push(n);
            n.specifiers.forEach(s => {
                if(s.type != 'ImportDefaultSpecifier') return;
                if(s.local.type != 'Identifier') return;
                result.imports.push(s.local.name);
            });
            return;
        } else if(n.type == 'ExportNamedDeclaration') {
            assert(n.declaration.type == 'VariableDeclaration', 'Wrong export');
            let forInit = [];
            n.declaration.declarations.forEach(d => {
                assert(d.type == 'VariableDeclarator', 'Wrong export');
                result.props.push(d.id.name);
                forInit.push(d.id.name);
            });
            resultBody.push(n.declaration);
            forInit.forEach(n => {
                resultBody.push(parseExp(`$$makeProp($component, $props, $option.boundProps || {}, '${n}', () => ${n}, _${n} => {${n} = _${n}; $$apply();})`));
                lastPropIndex = resultBody.length;
            });
            return;
        }

        if(n.type == 'LabeledStatement' && n.label.name == '$') {
            try {
                makeWatch(n);
                return;
            } catch (e) {
                throw new Error(e + ': ' + code.substring(n.start, n.end));
            }
        }
        resultBody.push(n);
    });

    resultBody.push({
        type: 'ExpressionStatement',
        expression: {
            callee: {
                type: 'Identifier',
                name: '$$runtime'
            },
            type: 'CallExpression'
        }
    });

    let header = [];
    header.push(parseExp('if(!$option) $option = {}'));
    header.push(parseExp('if(!$option.events) $option.events = {}'));
    header.push(parseExp('const $props = $option.props || {}'));
    header.push(parseExp('const $component = $$makeComponent($element, $option);'));
    header.push(parseExp('const $$apply = $$makeApply($component.$cd)'));

    if(lastPropIndex != null) {
        resultBody.splice(lastPropIndex, 0, parseExp('let $attributes = $$componentCompleteProps($component, $$apply, $props)'));
    } else {
        header.push(parseExp('$component.push = $$apply'));
        header.push(parseExp('const $attributes = $props'));
    }

    if(!rootFunctions.$emit) header.push(makeEmitter());
    if(insertOnDestroy) header.push(parseExp('function $onDestroy(fn) {$component.$cd.d(fn);}'));
    while(header.length) {
        resultBody.unshift(header.pop());
    }

    let widgetFunc = {
        body: {
            type: 'BlockStatement',
            body: resultBody
        },
        id: {
            type: 'Identifier"',
            name: option.name
        },
        params: [{
            type: 'Identifier',
            name: '$element'
        }, {
            type: 'Identifier',
            name: '$option'
        }],
        type: 'FunctionDeclaration'
    };

    if(option.exportDefault) {
        widgetFunc = {
            type: 'ExportDefaultDeclaration',
            declaration: widgetFunc
        }
    };

    ast.body = [widgetFunc];
    ast.body.unshift.apply(ast.body, imports);

    result.code = generate(ast);
    return result;
}

function makeEmitter() {
    return {
        type: 'VariableDeclaration',
        declarations: [{
            type: 'VariableDeclarator',
            id: {type: 'Identifier', name: '$emit'},
            init: {
                type: 'CallExpression',
                callee: {type: 'Identifier', name: '$makeEmitter'},
                arguments: [{type: 'Identifier', name: '$option'}]
            }
        }],
        kind: 'const'
    };
};


function parseExp(exp) {
    let ast = parse(exp);
    assert(ast.body.length == 1);
    return ast.body[0];
}
