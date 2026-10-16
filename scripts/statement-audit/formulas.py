"""Restricted source arithmetic; never evaluates Python or reads REST values."""
import ast
from dataclasses import dataclass
from decimal import Decimal
import re


class FormulaError(ValueError):
    pass


@dataclass
class Amount:
    value: Decimal
    terms: dict | None
    low: Decimal
    high: Decimal

    @classmethod
    def linear(cls, value, terms=None):
        value = Decimal(str(value))
        terms = {key: coefficient for key, coefficient in (terms or {}).items() if coefficient}
        radius = sum(map(abs, terms.values()), Decimal(0))
        return cls(value, terms, value - radius, value + radius)

    def scaled(self, factor):
        factor = Decimal(str(factor))
        if self.terms is not None:
            return Amount.linear(self.value * factor, {key: n * factor for key, n in self.terms.items()})
        bounds = (self.low * factor, self.high * factor)
        return Amount(self.value * factor, None, min(bounds), max(bounds))

    def add(self, other):
        if self.terms is not None and other.terms is not None:
            terms = self.terms.copy()
            for key, n in other.terms.items():
                terms[key] = terms.get(key, Decimal(0)) + n
            return Amount.linear(self.value + other.value, terms)
        return Amount(self.value + other.value, None, self.low + other.low, self.high + other.high)

    def multiply(self, other):
        if self.low == self.high:
            return other.scaled(self.value)
        if other.low == other.high:
            return self.scaled(other.value)
        bounds = [a * b for a in (self.low, self.high) for b in (other.low, other.high)]
        return Amount(self.value * other.value, None, min(bounds), max(bounds))

    def divide(self, other):
        if other.low <= 0 <= other.high:
            raise FormulaError("Jakajan lähdetarkkuusväli sisältää nollan; suhdelukua ei vahvistettu.")
        if other.low == other.high:
            return self.scaled(Decimal(1) / other.value)
        bounds = [a / b for a in (self.low, self.high) for b in (other.low, other.high)]
        return Amount(self.value / other.value, None, min(bounds), max(bounds))


@dataclass
class Condition:
    value: bool
    possible: set


def expression(text):
    text = re.sub(r"\[([A-Za-z][A-Za-z0-9_]*)\]", r'fact("\1")', text)
    text = re.sub(r"\bif\s*\(", "choose(", text).replace("&&", " and ").replace("||", " or ")
    try:
        tree = ast.parse(text.strip(), mode="eval")
    except (SyntaxError, RecursionError) as error:
        raise FormulaError("Lähdekaavan syntaksia ei tueta.") from error
    allowed = (ast.Expression, ast.Constant, ast.UnaryOp, ast.USub, ast.UAdd, ast.BinOp,
               ast.Add, ast.Sub, ast.Mult, ast.Div, ast.Call, ast.Name, ast.Load,
               ast.Compare, ast.Eq, ast.NotEq, ast.Lt, ast.LtE, ast.Gt, ast.GtE,
               ast.BoolOp, ast.And, ast.Or)
    nodes = list(ast.walk(tree))
    if len(nodes) > 10000 or any(not isinstance(node, allowed) for node in nodes):
        raise FormulaError("Lähdekaava sisältää toiminnon, jota ei tueta.")
    for node in nodes:
        if isinstance(node, ast.Name) and node.id not in {"fact", "v", "choose", "abs"}:
            raise FormulaError("Tuntematon lähdekaavan nimi.")
        if isinstance(node, ast.Call) and (not isinstance(node.func, ast.Name) or node.keywords):
            raise FormulaError("Lähdekaavan kutsua ei tueta.")
    return tree.body


def calculate(text, fact, variable, uncertain):
    """Callbacks select independently validated source facts, including prior periods."""
    def visit(node):
        if isinstance(node, ast.Constant) and type(node.value) in (int, float):
            return Amount.linear(node.value)
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.USub, ast.UAdd)):
            return visit(node.operand).scaled(-1 if isinstance(node.op, ast.USub) else 1)
        if isinstance(node, ast.BinOp):
            left, right = visit(node.left), visit(node.right)
            if isinstance(node.op, ast.Add):
                return left.add(right)
            if isinstance(node.op, ast.Sub):
                return left.add(right.scaled(-1))
            if isinstance(node.op, ast.Mult):
                return left.multiply(right)
            if isinstance(node.op, ast.Div):
                return left.divide(right)
        if isinstance(node, ast.Compare) and len(node.ops) == 1:
            difference = visit(node.left).add(visit(node.comparators[0]).scaled(-1))
            value, lo, hi = difference.value, difference.low, difference.high
            op = node.ops[0]
            if isinstance(op, (ast.Eq, ast.NotEq)):
                nominal = value == 0
                possible = {True} if lo == hi == 0 else {False} if hi < 0 or lo > 0 else {True, False}
                if isinstance(op, ast.NotEq):
                    nominal, possible = not nominal, {not p for p in possible}
            elif isinstance(op, (ast.Gt, ast.GtE, ast.Lt, ast.LtE)):
                if isinstance(op, (ast.Lt, ast.LtE)):
                    value, lo, hi = -value, -hi, -lo
                inclusive = isinstance(op, (ast.GtE, ast.LtE))
                nominal = value >= 0 if inclusive else value > 0
                possible = ({True} if lo >= 0 else {False} if hi < 0 else {True, False}) if inclusive else (
                    {True} if lo > 0 else {False} if hi <= 0 else {True, False})
            else:
                raise FormulaError("Lähdekaavan vertailua ei tueta.")
            return Condition(nominal, possible)
        if isinstance(node, ast.BoolOp):
            result = visit(node.values[0])
            for child in node.values[1:]:
                if isinstance(node.op, ast.And) and result.possible == {False}:
                    break
                if isinstance(node.op, ast.Or) and result.possible == {True}:
                    break
                other = visit(child)
                operation = (lambda a, b: a and b) if isinstance(node.op, ast.And) else (lambda a, b: a or b)
                result = Condition(operation(result.value, other.value),
                                   {operation(a, b) for a in result.possible for b in other.possible})
            return result
        if isinstance(node, ast.Call):
            name = node.func.id
            if name in {"fact", "v"}:
                if not 1 <= len(node.args) <= 2 or not isinstance(node.args[0], ast.Constant) or not isinstance(node.args[0].value, str):
                    raise FormulaError("Lähdekaavan lähdeviite on virheellinen.")
                offset = 0
                if len(node.args) == 2:
                    amount = visit(node.args[1])
                    if amount.low != amount.high or amount.value not in (0, -1):
                        raise FormulaError("Vain nykyinen ja edeltävä tilikausi ovat tuettuja.")
                    offset = int(amount.value)
                return (fact if name == "fact" else variable)(node.args[0].value, offset)
            if name == "choose" and len(node.args) == 3:
                condition = visit(node.args[0])
                if not isinstance(condition, Condition):
                    raise FormulaError("Lähdekaavan ehto ei ole vertailu.")
                if len(condition.possible) != 1:
                    uncertain("Laskentakaavan ehto voi vaihtua lähteen pyöristysvälillä.")
                return visit(node.args[1] if condition.value else node.args[2])
            if name == "abs" and len(node.args) == 1:
                amount = visit(node.args[0])
                if amount.low >= 0:
                    return amount
                if amount.high <= 0:
                    return amount.scaled(-1)
                return Amount(abs(amount.value), None, Decimal(0), max(-amount.low, amount.high))
        raise FormulaError("Lähdekaavan rakenne tai argumentit eivät ole tuettuja.")

    try:
        result = visit(expression(text))
        if not isinstance(result, Amount) or any(not n.is_finite() for n in (result.value, result.low, result.high)):
            raise FormulaError("Lähdekaava ei tuottanut äärellistä lukua.")
        return result
    except (ArithmeticError, AttributeError, TypeError, RecursionError) as error:
        raise FormulaError("Lähdekaavaa ei voitu laskea turvallisesti.") from error
