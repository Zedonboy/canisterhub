// Generated from a hand-written catalogue. Every function listed here was checked
// against the bundled Formualizer engine (unknown names return #NAME?), and each
// `result` is what the engine returned for `example`. CHILDREN and AVG are
// IntelliSheet additions handled by the formula parser.

export interface FormulaFunction {
	name: string;
	category: string;
	syntax: string;
	description: string;
	/** A formula you can type as-is. */
	example: string;
	/** What the engine returns for `example` (omitted when it varies or needs sheet context). */
	result?: string;
	/** The same function used with IntelliSheet column references. */
	sheetExample?: string;
	note?: string;
}

export const FUNCTION_CATEGORIES = [
	"Math & trig",
	"Logical",
	"Text",
	"Date & time",
	"Lookup & reference",
	"Information",
	"Statistical",
	"Financial",
	"Engineering",
	"Database",
	"Compatibility",
	"IntelliSheet"
];

export const FORMULA_FUNCTIONS: FormulaFunction[] = [
	{
		"name": "ABS",
		"category": "Math & trig",
		"syntax": "ABS(number)",
		"description": "Returns the absolute value of a number: its size without the sign.",
		"example": "=ABS(-42)",
		"result": "42"
	},
	{
		"name": "ACCRINT",
		"category": "Financial",
		"syntax": "ACCRINT(issue, first_interest, settlement, rate, par, frequency, [basis], [calc_method])",
		"description": "Returns the interest accrued on a security that pays interest periodically.",
		"example": "=ACCRINT(DATE(2026, 1, 1), DATE(2026, 7, 1), DATE(2026, 4, 1), 0.05, 1000, 2)",
		"result": "12.5"
	},
	{
		"name": "ACCRINTM",
		"category": "Financial",
		"syntax": "ACCRINTM(issue, settlement, rate, par, [basis])",
		"description": "Returns the interest accrued on a security that pays interest at maturity.",
		"example": "=ACCRINTM(DATE(2026, 1, 1), DATE(2026, 12, 31), 0.05, 1000)",
		"result": "50"
	},
	{
		"name": "ACOS",
		"category": "Math & trig",
		"syntax": "ACOS(number)",
		"description": "Returns the arccosine of a number, in radians.",
		"example": "=ACOS(0.5)",
		"result": "1.047197551"
	},
	{
		"name": "ACOSH",
		"category": "Math & trig",
		"syntax": "ACOSH(number)",
		"description": "Returns the inverse hyperbolic cosine of a number.",
		"example": "=ACOSH(2)",
		"result": "1.316957897"
	},
	{
		"name": "ACOT",
		"category": "Math & trig",
		"syntax": "ACOT(number)",
		"description": "Returns the arccotangent of a number, in radians.",
		"example": "=ACOT(1)",
		"result": "0.7853981634"
	},
	{
		"name": "ACOTH",
		"category": "Math & trig",
		"syntax": "ACOTH(number)",
		"description": "Returns the inverse hyperbolic cotangent of a number.",
		"example": "=ACOTH(2)",
		"result": "0.5493061443"
	},
	{
		"name": "ADDRESS",
		"category": "Lookup & reference",
		"syntax": "ADDRESS(row_num, column_num, [abs_num], [a1], [sheet_text])",
		"description": "Returns a cell address, such as $C$2, as text.",
		"example": "=ADDRESS(2, 3)",
		"result": "$C$2"
	},
	{
		"name": "AND",
		"category": "Logical",
		"syntax": "AND(logical1, [logical2], …)",
		"description": "Returns TRUE only if all of its arguments are TRUE.",
		"example": "=AND(5 > 3, 2 < 1)",
		"sheetExample": "=AND([Amount]@row > 1000, [Status]@row = \"Unpaid\")",
		"result": "FALSE"
	},
	{
		"name": "ARABIC",
		"category": "Math & trig",
		"syntax": "ARABIC(text)",
		"description": "Converts a Roman numeral to a number.",
		"example": "=ARABIC(\"MMXXVI\")",
		"result": "2026"
	},
	{
		"name": "ARRAYTOTEXT",
		"category": "Text",
		"syntax": "ARRAYTOTEXT(array, [format])",
		"description": "Returns the values of an array as one piece of text.",
		"example": "=ARRAYTOTEXT({1, 2, 3})",
		"result": "1, 2, 3"
	},
	{
		"name": "ASC",
		"category": "Text",
		"syntax": "ASC(text)",
		"description": "Changes full-width (double-byte) characters to half-width (single-byte) ones.",
		"example": "=ASC(\"ＡＢＣ\")",
		"result": "ABC"
	},
	{
		"name": "ASIN",
		"category": "Math & trig",
		"syntax": "ASIN(number)",
		"description": "Returns the arcsine of a number, in radians.",
		"example": "=ASIN(1)",
		"result": "1.570796327"
	},
	{
		"name": "ASINH",
		"category": "Math & trig",
		"syntax": "ASINH(number)",
		"description": "Returns the inverse hyperbolic sine of a number.",
		"example": "=ASINH(1)",
		"result": "0.881373587"
	},
	{
		"name": "ATAN",
		"category": "Math & trig",
		"syntax": "ATAN(number)",
		"description": "Returns the arctangent of a number, in radians.",
		"example": "=ATAN(1)",
		"result": "0.7853981634"
	},
	{
		"name": "ATAN2",
		"category": "Math & trig",
		"syntax": "ATAN2(x_num, y_num)",
		"description": "Returns the angle, in radians, between the x-axis and the point (x, y).",
		"example": "=ATAN2(1, 1)",
		"result": "0.7853981634"
	},
	{
		"name": "ATANH",
		"category": "Math & trig",
		"syntax": "ATANH(number)",
		"description": "Returns the inverse hyperbolic tangent of a number.",
		"example": "=ATANH(0.5)",
		"result": "0.5493061443"
	},
	{
		"name": "AVEDEV",
		"category": "Statistical",
		"syntax": "AVEDEV(number1, [number2], …)",
		"description": "Returns the average of the absolute distances of values from their mean.",
		"example": "=AVEDEV(2, 4, 6, 8)",
		"result": "2"
	},
	{
		"name": "AVERAGE",
		"category": "Statistical",
		"syntax": "AVERAGE(number1, [number2], …)",
		"description": "Returns the average (arithmetic mean) of its arguments. AVG works too.",
		"example": "=AVERAGE(10, 20, 30)",
		"sheetExample": "=AVERAGE([Amount]:[Amount])",
		"result": "20"
	},
	{
		"name": "AVERAGEA",
		"category": "Statistical",
		"syntax": "AVERAGEA(value1, [value2], …)",
		"description": "Returns the average, counting TRUE as 1 and text or FALSE as 0.",
		"example": "=AVERAGEA(10, TRUE, 20)",
		"result": "10.33333333"
	},
	{
		"name": "AVERAGEIF",
		"category": "Statistical",
		"syntax": "AVERAGEIF(range, criteria, [average_range])",
		"description": "Returns the average of the values that meet one condition.",
		"example": "=AVERAGEIF({5, 15, 25}, \">10\")",
		"sheetExample": "=AVERAGEIF([Status]:[Status], \"Unpaid\", [Amount]:[Amount])",
		"result": "20"
	},
	{
		"name": "AVERAGEIFS",
		"category": "Statistical",
		"syntax": "AVERAGEIFS(average_range, criteria_range1, criteria1, …)",
		"description": "Returns the average of the values that meet every one of several conditions.",
		"example": "=AVERAGEIFS({10, 20, 30}, {\"a\", \"b\", \"a\"}, \"a\")",
		"result": "20"
	},
	{
		"name": "AVG",
		"category": "IntelliSheet",
		"syntax": "AVG(number1, [number2], …)",
		"description": "Another name for AVERAGE, as in Smartsheet: returns the average of its arguments.",
		"example": "=AVG(10, 20, 30)",
		"sheetExample": "=AVG([Amount]:[Amount])",
		"result": "20"
	},
	{
		"name": "BASE",
		"category": "Math & trig",
		"syntax": "BASE(number, radix, [min_length])",
		"description": "Converts a number to text in another base, such as binary (2) or hexadecimal (16).",
		"example": "=BASE(255, 16)",
		"result": "FF"
	},
	{
		"name": "BESSELI",
		"category": "Engineering",
		"syntax": "BESSELI(x, n)",
		"description": "Returns the modified Bessel function In(x).",
		"example": "=BESSELI(1.5, 1)",
		"result": "0.9816664285"
	},
	{
		"name": "BESSELJ",
		"category": "Engineering",
		"syntax": "BESSELJ(x, n)",
		"description": "Returns the Bessel function Jn(x).",
		"example": "=BESSELJ(1.9, 2)",
		"result": "0.3299257277"
	},
	{
		"name": "BESSELK",
		"category": "Engineering",
		"syntax": "BESSELK(x, n)",
		"description": "Returns the modified Bessel function Kn(x).",
		"example": "=BESSELK(1.5, 1)",
		"result": "0.2773878036"
	},
	{
		"name": "BESSELY",
		"category": "Engineering",
		"syntax": "BESSELY(x, n)",
		"description": "Returns the Bessel function Yn(x).",
		"example": "=BESSELY(2.5, 1)",
		"result": "0.145918138"
	},
	{
		"name": "BETA.DIST",
		"category": "Statistical",
		"syntax": "BETA.DIST(x, alpha, beta, cumulative, [A], [B])",
		"description": "Returns the beta distribution.",
		"example": "=BETA.DIST(0.4, 2, 3, TRUE)",
		"result": "0.5248"
	},
	{
		"name": "BETA.INV",
		"category": "Statistical",
		"syntax": "BETA.INV(probability, alpha, beta, [A], [B])",
		"description": "Returns the inverse of the cumulative beta distribution.",
		"example": "=BETA.INV(0.5, 2, 3)",
		"result": "0.3857275681"
	},
	{
		"name": "BIN2DEC",
		"category": "Engineering",
		"syntax": "BIN2DEC(number)",
		"description": "Converts a binary number to decimal.",
		"example": "=BIN2DEC(\"1100100\")",
		"result": "100"
	},
	{
		"name": "BIN2HEX",
		"category": "Engineering",
		"syntax": "BIN2HEX(number, [places])",
		"description": "Converts a binary number to hexadecimal.",
		"example": "=BIN2HEX(\"11111011\", 4)",
		"result": "00FB"
	},
	{
		"name": "BIN2OCT",
		"category": "Engineering",
		"syntax": "BIN2OCT(number, [places])",
		"description": "Converts a binary number to octal.",
		"example": "=BIN2OCT(\"1001\", 3)",
		"result": "011"
	},
	{
		"name": "BINOM.DIST",
		"category": "Statistical",
		"syntax": "BINOM.DIST(number_s, trials, probability_s, cumulative)",
		"description": "Returns the binomial distribution probability.",
		"example": "=BINOM.DIST(6, 10, 0.5, FALSE)",
		"result": "0.205078125"
	},
	{
		"name": "BINOM.DIST.RANGE",
		"category": "Statistical",
		"syntax": "BINOM.DIST.RANGE(trials, probability_s, number_s, [number_s2])",
		"description": "Returns the probability of a number, or a range, of successes in a set of trials.",
		"example": "=BINOM.DIST.RANGE(10, 0.5, 4, 6)",
		"result": "0.65625"
	},
	{
		"name": "BINOM.INV",
		"category": "Statistical",
		"syntax": "BINOM.INV(trials, probability_s, alpha)",
		"description": "Returns the smallest number of successes whose cumulative binomial probability reaches alpha.",
		"example": "=BINOM.INV(10, 0.5, 0.75)",
		"result": "6"
	},
	{
		"name": "BITAND",
		"category": "Engineering",
		"syntax": "BITAND(number1, number2)",
		"description": "Returns the bitwise AND of two numbers.",
		"example": "=BITAND(13, 25)",
		"result": "9"
	},
	{
		"name": "BITLSHIFT",
		"category": "Engineering",
		"syntax": "BITLSHIFT(number, shift_amount)",
		"description": "Shifts a number's bits to the left.",
		"example": "=BITLSHIFT(4, 2)",
		"result": "16"
	},
	{
		"name": "BITOR",
		"category": "Engineering",
		"syntax": "BITOR(number1, number2)",
		"description": "Returns the bitwise OR of two numbers.",
		"example": "=BITOR(23, 10)",
		"result": "31"
	},
	{
		"name": "BITRSHIFT",
		"category": "Engineering",
		"syntax": "BITRSHIFT(number, shift_amount)",
		"description": "Shifts a number's bits to the right.",
		"example": "=BITRSHIFT(13, 2)",
		"result": "3"
	},
	{
		"name": "BITXOR",
		"category": "Engineering",
		"syntax": "BITXOR(number1, number2)",
		"description": "Returns the bitwise exclusive OR of two numbers.",
		"example": "=BITXOR(5, 3)",
		"result": "6"
	},
	{
		"name": "CEILING",
		"category": "Math & trig",
		"syntax": "CEILING(number, significance)",
		"description": "Rounds a number up to the nearest multiple of significance.",
		"example": "=CEILING(4.3, 0.5)",
		"result": "4.5"
	},
	{
		"name": "CEILING.MATH",
		"category": "Math & trig",
		"syntax": "CEILING.MATH(number, [significance], [mode])",
		"description": "Rounds a number up to the nearest integer or multiple; mode controls how negative numbers round.",
		"example": "=CEILING.MATH(-4.3)",
		"result": "-4"
	},
	{
		"name": "CEILING.PRECISE",
		"category": "Math & trig",
		"syntax": "CEILING.PRECISE(number, [significance])",
		"description": "Rounds a number up to the nearest multiple, whatever its sign.",
		"example": "=CEILING.PRECISE(4.3, 2)",
		"result": "6"
	},
	{
		"name": "CELL",
		"category": "Information",
		"syntax": "CELL(info_type, [reference])",
		"description": "Returns information about a cell, such as its row (\"row\") or address (\"address\").",
		"example": "=CELL(\"row\", C5)",
		"note": "Takes A1-style cell references, which IntelliSheet sheets don't use, so it is mainly useful with values built inside the formula.",
		"result": "5"
	},
	{
		"name": "CHAR",
		"category": "Text",
		"syntax": "CHAR(number)",
		"description": "Returns the character for a character code.",
		"example": "=CHAR(65)",
		"result": "A"
	},
	{
		"name": "CHILDREN",
		"category": "IntelliSheet",
		"syntax": "CHILDREN([Column])",
		"description": "Refers to the values of a column in the current row's child rows (the rows nested directly under it). Use it inside functions such as SUM, COUNT or AVERAGE to roll values up to a parent row.",
		"example": "=SUM(CHILDREN([Amount]))",
		"note": "Works only in IntelliSheet formulas; the example needs a sheet with nested rows, so it has no fixed result."
	},
	{
		"name": "CHISQ.DIST",
		"category": "Statistical",
		"syntax": "CHISQ.DIST(x, deg_freedom, cumulative)",
		"description": "Returns the left-tailed chi-squared distribution.",
		"example": "=CHISQ.DIST(3, 2, TRUE)",
		"result": "0.7768698399"
	},
	{
		"name": "CHISQ.DIST.RT",
		"category": "Statistical",
		"syntax": "CHISQ.DIST.RT(x, deg_freedom)",
		"description": "Returns the right-tailed chi-squared distribution.",
		"example": "=CHISQ.DIST.RT(3, 2)",
		"result": "0.2231301601"
	},
	{
		"name": "CHISQ.INV",
		"category": "Statistical",
		"syntax": "CHISQ.INV(probability, deg_freedom)",
		"description": "Returns the inverse of the left-tailed chi-squared distribution.",
		"example": "=CHISQ.INV(0.5, 2)",
		"result": "1.386294361"
	},
	{
		"name": "CHISQ.INV.RT",
		"category": "Statistical",
		"syntax": "CHISQ.INV.RT(probability, deg_freedom)",
		"description": "Returns the inverse of the right-tailed chi-squared distribution.",
		"example": "=CHISQ.INV.RT(0.05, 2)",
		"result": "5.991464547"
	},
	{
		"name": "CHISQ.TEST",
		"category": "Statistical",
		"syntax": "CHISQ.TEST(actual_range, expected_range)",
		"description": "Returns the chi-squared test of independence for observed and expected values.",
		"example": "=CHISQ.TEST({58, 35; 11, 25}, {45.35, 47.65; 23.65, 24.35})",
		"result": "0.003389711718"
	},
	{
		"name": "CHITEST",
		"category": "Compatibility",
		"syntax": "CHITEST(actual_range, expected_range)",
		"description": "Older name for CHISQ.TEST. Returns the chi-squared test of independence for observed and expected values.",
		"example": "=CHITEST({58, 35; 11, 25}, {45.35, 47.65; 23.65, 24.35})",
		"result": "0.003389711718"
	},
	{
		"name": "CHOOSE",
		"category": "Lookup & reference",
		"syntax": "CHOOSE(index_num, value1, [value2], …)",
		"description": "Returns the value at a position in a list of values.",
		"example": "=CHOOSE(2, \"Low\", \"Medium\", \"High\")",
		"result": "Medium"
	},
	{
		"name": "CHOOSECOLS",
		"category": "Lookup & reference",
		"syntax": "CHOOSECOLS(array, col_num1, [col_num2], …)",
		"description": "Returns the columns you choose from an array.",
		"example": "=CHOOSECOLS({1, 2, 3; 4, 5, 6}, 3)",
		"note": "Returns several values; a cell shows the first one.",
		"result": "3"
	},
	{
		"name": "CHOOSEROWS",
		"category": "Lookup & reference",
		"syntax": "CHOOSEROWS(array, row_num1, [row_num2], …)",
		"description": "Returns the rows you choose from an array.",
		"example": "=CHOOSEROWS({1, 2, 3; 4, 5, 6}, 2)",
		"note": "Returns several values; a cell shows the first one.",
		"result": "4"
	},
	{
		"name": "CLEAN",
		"category": "Text",
		"syntax": "CLEAN(text)",
		"description": "Removes characters that can't be printed, such as line feeds and control codes.",
		"example": "=CLEAN(\"Report\" & CHAR(7))",
		"result": "Report"
	},
	{
		"name": "CODE",
		"category": "Text",
		"syntax": "CODE(text)",
		"description": "Returns the character code of the first character in text.",
		"example": "=CODE(\"A\")",
		"result": "65"
	},
	{
		"name": "COLUMN",
		"category": "Lookup & reference",
		"syntax": "COLUMN([reference])",
		"description": "Returns the column number of a reference.",
		"example": "=COLUMN(C5)",
		"note": "Takes A1-style cell references, which IntelliSheet sheets don't use, so it is mainly useful with values built inside the formula.",
		"result": "3"
	},
	{
		"name": "COLUMNS",
		"category": "Lookup & reference",
		"syntax": "COLUMNS(array)",
		"description": "Returns the number of columns in an array or range.",
		"example": "=COLUMNS({1, 2, 3; 4, 5, 6})",
		"result": "3"
	},
	{
		"name": "COMBIN",
		"category": "Math & trig",
		"syntax": "COMBIN(number, number_chosen)",
		"description": "Returns how many ways you can choose items from a set when order doesn't matter.",
		"example": "=COMBIN(8, 3)",
		"result": "56"
	},
	{
		"name": "COMBINA",
		"category": "Math & trig",
		"syntax": "COMBINA(number, number_chosen)",
		"description": "Returns the number of combinations when items can repeat.",
		"example": "=COMBINA(4, 3)",
		"result": "20"
	},
	{
		"name": "COMPLEX",
		"category": "Engineering",
		"syntax": "COMPLEX(real_num, i_num, [suffix])",
		"description": "Builds a complex number from real and imaginary parts.",
		"example": "=COMPLEX(3, 4)",
		"result": "3+4i"
	},
	{
		"name": "CONCAT",
		"category": "Text",
		"syntax": "CONCAT(text1, [text2], …)",
		"description": "Joins text from several values or ranges into one.",
		"example": "=CONCAT(\"Invoice \", \"BW-2291\")",
		"sheetExample": "=CONCAT([Supplier]@row, \" - \", [Invoice No.]@row)",
		"result": "Invoice BW-2291"
	},
	{
		"name": "CONCATENATE",
		"category": "Text",
		"syntax": "CONCATENATE(text1, [text2], …)",
		"description": "Joins several values into one piece of text (the older form of CONCAT).",
		"example": "=CONCATENATE(\"Q\", 3, \" report\")",
		"result": "Q3 report"
	},
	{
		"name": "CONFIDENCE",
		"category": "Compatibility",
		"syntax": "CONFIDENCE(alpha, standard_dev, size)",
		"description": "Older name for CONFIDENCE.NORM. Returns the margin of error for a population mean, using a normal distribution.",
		"example": "=CONFIDENCE(0.05, 2.5, 50)",
		"result": "0.6929519127"
	},
	{
		"name": "CONFIDENCE.NORM",
		"category": "Statistical",
		"syntax": "CONFIDENCE.NORM(alpha, standard_dev, size)",
		"description": "Returns the margin of error for a population mean, using a normal distribution.",
		"example": "=CONFIDENCE.NORM(0.05, 2.5, 50)",
		"result": "0.6929519127"
	},
	{
		"name": "CONFIDENCE.T",
		"category": "Statistical",
		"syntax": "CONFIDENCE.T(alpha, standard_dev, size)",
		"description": "Returns the margin of error for a population mean, using a Student's t distribution.",
		"example": "=CONFIDENCE.T(0.05, 2.5, 50)",
		"result": "0.7104921387"
	},
	{
		"name": "CONVERT",
		"category": "Engineering",
		"syntax": "CONVERT(number, from_unit, to_unit)",
		"description": "Converts a number from one unit of measurement to another.",
		"example": "=CONVERT(68, \"F\", \"C\")",
		"result": "20"
	},
	{
		"name": "CORREL",
		"category": "Statistical",
		"syntax": "CORREL(array1, array2)",
		"description": "Returns the correlation coefficient of two sets of values, from -1 to 1.",
		"example": "=CORREL({1, 2, 3, 4}, {2, 4, 5, 9})",
		"result": "0.9647638212"
	},
	{
		"name": "COS",
		"category": "Math & trig",
		"syntax": "COS(number)",
		"description": "Returns the cosine of an angle given in radians.",
		"example": "=COS(PI())",
		"result": "-1"
	},
	{
		"name": "COSH",
		"category": "Math & trig",
		"syntax": "COSH(number)",
		"description": "Returns the hyperbolic cosine of a number.",
		"example": "=COSH(1)",
		"result": "1.543080635"
	},
	{
		"name": "COT",
		"category": "Math & trig",
		"syntax": "COT(number)",
		"description": "Returns the cotangent of an angle given in radians.",
		"example": "=COT(1)",
		"result": "0.6420926159"
	},
	{
		"name": "COTH",
		"category": "Math & trig",
		"syntax": "COTH(number)",
		"description": "Returns the hyperbolic cotangent of a number.",
		"example": "=COTH(1)",
		"result": "1.313035285"
	},
	{
		"name": "COUNT",
		"category": "Statistical",
		"syntax": "COUNT(value1, [value2], …)",
		"description": "Counts how many values are numbers.",
		"example": "=COUNT(10, \"text\", 30)",
		"sheetExample": "=COUNT([Amount]:[Amount])",
		"result": "2"
	},
	{
		"name": "COUNTA",
		"category": "Statistical",
		"syntax": "COUNTA(value1, [value2], …)",
		"description": "Counts how many values are not empty.",
		"example": "=COUNTA(1, \"a\", TRUE)",
		"sheetExample": "=COUNTA([Supplier]:[Supplier])",
		"result": "3"
	},
	{
		"name": "COUNTBLANK",
		"category": "Statistical",
		"syntax": "COUNTBLANK(range)",
		"description": "Counts the empty cells in a range.",
		"example": "=COUNTBLANK({1, \"\"})",
		"sheetExample": "=COUNTBLANK([Notes]:[Notes])",
		"result": "1"
	},
	{
		"name": "COUNTIF",
		"category": "Statistical",
		"syntax": "COUNTIF(range, criteria)",
		"description": "Counts the values that meet one condition.",
		"example": "=COUNTIF({\"Paid\", \"Unpaid\", \"Paid\"}, \"Paid\")",
		"sheetExample": "=COUNTIF([Status]:[Status], \"Paid\")",
		"result": "2"
	},
	{
		"name": "COUNTIFS",
		"category": "Statistical",
		"syntax": "COUNTIFS(criteria_range1, criteria1, [criteria_range2, criteria2], …)",
		"description": "Counts the rows that meet every one of several conditions.",
		"example": "=COUNTIFS({\"Paid\", \"Unpaid\", \"Paid\"}, \"Paid\", {100, 200, 300}, \">150\")",
		"sheetExample": "=COUNTIFS([Status]:[Status], \"Unpaid\", [Amount]:[Amount], \">1000\")",
		"result": "1"
	},
	{
		"name": "COVAR",
		"category": "Compatibility",
		"syntax": "COVAR(array1, array2)",
		"description": "Older name for COVARIANCE.P. Returns the population covariance of two sets of values.",
		"example": "=COVAR({1, 2, 3}, {2, 4, 7})",
		"result": "1.666666667"
	},
	{
		"name": "COVARIANCE.P",
		"category": "Statistical",
		"syntax": "COVARIANCE.P(array1, array2)",
		"description": "Returns the population covariance of two sets of values.",
		"example": "=COVARIANCE.P({1, 2, 3}, {2, 4, 7})",
		"result": "1.666666667"
	},
	{
		"name": "COVARIANCE.S",
		"category": "Statistical",
		"syntax": "COVARIANCE.S(array1, array2)",
		"description": "Returns the sample covariance of two sets of values.",
		"example": "=COVARIANCE.S({1, 2, 3}, {2, 4, 7})",
		"result": "2.5"
	},
	{
		"name": "CRITBINOM",
		"category": "Compatibility",
		"syntax": "CRITBINOM(trials, probability_s, alpha)",
		"description": "Older name for BINOM.INV. Returns the smallest number of successes whose cumulative binomial probability reaches alpha.",
		"example": "=CRITBINOM(10, 0.5, 0.75)",
		"result": "6"
	},
	{
		"name": "CSC",
		"category": "Math & trig",
		"syntax": "CSC(number)",
		"description": "Returns the cosecant of an angle given in radians.",
		"example": "=CSC(1)",
		"result": "1.188395106"
	},
	{
		"name": "CSCH",
		"category": "Math & trig",
		"syntax": "CSCH(number)",
		"description": "Returns the hyperbolic cosecant of a number.",
		"example": "=CSCH(1)",
		"result": "0.8509181282"
	},
	{
		"name": "CUMIPMT",
		"category": "Financial",
		"syntax": "CUMIPMT(rate, nper, pv, start_period, end_period, type)",
		"description": "Returns the total interest paid on a loan between two periods.",
		"example": "=CUMIPMT(0.09 / 12, 360, 125000, 13, 24, 0)",
		"note": "This engine's result doesn't match Excel for this function (the sign and totals differ), so check the numbers before relying on them."
	},
	{
		"name": "CUMPRINC",
		"category": "Financial",
		"syntax": "CUMPRINC(rate, nper, pv, start_period, end_period, type)",
		"description": "Returns the total principal repaid on a loan between two periods.",
		"example": "=CUMPRINC(0.09 / 12, 360, 125000, 13, 24, 0)",
		"note": "This engine's result doesn't match Excel for this function (the sign and totals differ), so check the numbers before relying on them."
	},
	{
		"name": "DATE",
		"category": "Date & time",
		"syntax": "DATE(year, month, day)",
		"description": "Returns a date from year, month and day numbers.",
		"example": "=DATE(2026, 3, 14)",
		"result": "2026-03-14"
	},
	{
		"name": "DATEDIF",
		"category": "Date & time",
		"syntax": "DATEDIF(start_date, end_date, unit)",
		"description": "Returns the number of whole days (\"D\"), months (\"M\") or years (\"Y\") between two dates.",
		"example": "=DATEDIF(DATE(2025, 1, 15), DATE(2026, 3, 14), \"M\")",
		"result": "13"
	},
	{
		"name": "DATEVALUE",
		"category": "Date & time",
		"syntax": "DATEVALUE(date_text)",
		"description": "Converts a date written as text into a date.",
		"example": "=DATEVALUE(\"2026-03-14\")",
		"result": "2026-03-14"
	},
	{
		"name": "DAVERAGE",
		"category": "Database",
		"syntax": "DAVERAGE(database, field, criteria)",
		"description": "Averages the values in a column of a table for the rows that match the criteria.",
		"example": "=DAVERAGE({\"Supplier\", \"Amount\"; \"Acme\", 1250; \"Zenith\", 2410; \"Acme\", 990}, \"Amount\", {\"Supplier\"; \"Acme\"})",
		"result": "1120"
	},
	{
		"name": "DAY",
		"category": "Date & time",
		"syntax": "DAY(date)",
		"description": "Returns the day of the month, from 1 to 31.",
		"example": "=DAY(DATE(2026, 3, 14))",
		"result": "14"
	},
	{
		"name": "DAYS",
		"category": "Date & time",
		"syntax": "DAYS(end_date, start_date)",
		"description": "Returns the number of days between two dates.",
		"example": "=DAYS(DATE(2026, 12, 25), DATE(2026, 9, 15))",
		"result": "101"
	},
	{
		"name": "DAYS360",
		"category": "Date & time",
		"syntax": "DAYS360(start_date, end_date, [method])",
		"description": "Returns the number of days between two dates based on a 360-day year, as used in some accounting.",
		"example": "=DAYS360(DATE(2026, 1, 1), DATE(2026, 12, 31))",
		"result": "360"
	},
	{
		"name": "DB",
		"category": "Financial",
		"syntax": "DB(cost, salvage, life, period, [month])",
		"description": "Returns depreciation for a period using the fixed-declining balance method.",
		"example": "=DB(10000, 1000, 5, 1)",
		"result": "3690"
	},
	{
		"name": "DCOUNT",
		"category": "Database",
		"syntax": "DCOUNT(database, field, criteria)",
		"description": "Counts the numbers in a column of a table for the rows that match the criteria.",
		"example": "=DCOUNT({\"Supplier\", \"Amount\"; \"Acme\", 1250; \"Zenith\", 2410; \"Acme\", 990}, \"Amount\", {\"Supplier\"; \"Acme\"})",
		"result": "2"
	},
	{
		"name": "DCOUNTA",
		"category": "Database",
		"syntax": "DCOUNTA(database, field, criteria)",
		"description": "Counts the non-empty values in a column of a table for the rows that match the criteria.",
		"example": "=DCOUNTA({\"Supplier\", \"Amount\"; \"Acme\", 1250; \"Zenith\", 2410; \"Acme\", 990}, \"Supplier\", {\"Supplier\"; \"Acme\"})",
		"result": "2"
	},
	{
		"name": "DDB",
		"category": "Financial",
		"syntax": "DDB(cost, salvage, life, period, [factor])",
		"description": "Returns depreciation for a period using the double-declining balance method.",
		"example": "=DDB(10000, 1000, 5, 1)",
		"result": "4000"
	},
	{
		"name": "DEC2BIN",
		"category": "Engineering",
		"syntax": "DEC2BIN(number, [places])",
		"description": "Converts a decimal number to binary.",
		"example": "=DEC2BIN(9, 4)",
		"result": "1001"
	},
	{
		"name": "DEC2HEX",
		"category": "Engineering",
		"syntax": "DEC2HEX(number, [places])",
		"description": "Converts a decimal number to hexadecimal.",
		"example": "=DEC2HEX(255)",
		"result": "FF"
	},
	{
		"name": "DEC2OCT",
		"category": "Engineering",
		"syntax": "DEC2OCT(number, [places])",
		"description": "Converts a decimal number to octal.",
		"example": "=DEC2OCT(58, 3)",
		"result": "072"
	},
	{
		"name": "DECIMAL",
		"category": "Math & trig",
		"syntax": "DECIMAL(text, radix)",
		"description": "Converts text representing a number in another base into a decimal number.",
		"example": "=DECIMAL(\"FF\", 16)",
		"result": "255"
	},
	{
		"name": "DEGREES",
		"category": "Math & trig",
		"syntax": "DEGREES(angle)",
		"description": "Converts radians to degrees.",
		"example": "=DEGREES(PI())",
		"result": "180"
	},
	{
		"name": "DELTA",
		"category": "Engineering",
		"syntax": "DELTA(number1, [number2])",
		"description": "Returns 1 if two numbers are equal and 0 otherwise.",
		"example": "=DELTA(5, 5)",
		"result": "1"
	},
	{
		"name": "DEVSQ",
		"category": "Statistical",
		"syntax": "DEVSQ(number1, [number2], …)",
		"description": "Returns the sum of the squared distances of values from their mean.",
		"example": "=DEVSQ(4, 5, 8, 7)",
		"result": "10"
	},
	{
		"name": "DGET",
		"category": "Database",
		"syntax": "DGET(database, field, criteria)",
		"description": "Returns the one value in a column of a table that matches the criteria.",
		"example": "=DGET({\"Supplier\", \"Amount\"; \"Acme\", 1250; \"Zenith\", 2410; \"Acme\", 990}, \"Amount\", {\"Supplier\"; \"Zenith\"})",
		"result": "2410"
	},
	{
		"name": "DMAX",
		"category": "Database",
		"syntax": "DMAX(database, field, criteria)",
		"description": "Returns the largest value in a column of a table for the rows that match the criteria.",
		"example": "=DMAX({\"Supplier\", \"Amount\"; \"Acme\", 1250; \"Zenith\", 2410; \"Acme\", 990}, \"Amount\", {\"Supplier\"; \"Acme\"})",
		"result": "1250"
	},
	{
		"name": "DMIN",
		"category": "Database",
		"syntax": "DMIN(database, field, criteria)",
		"description": "Returns the smallest value in a column of a table for the rows that match the criteria.",
		"example": "=DMIN({\"Supplier\", \"Amount\"; \"Acme\", 1250; \"Zenith\", 2410; \"Acme\", 990}, \"Amount\", {\"Supplier\"; \"Acme\"})",
		"result": "990"
	},
	{
		"name": "DOLLAR",
		"category": "Text",
		"syntax": "DOLLAR(number, [decimals])",
		"description": "Formats a number as currency text.",
		"example": "=DOLLAR(1234.567, 2)",
		"result": "$1,234.57"
	},
	{
		"name": "DOLLARDE",
		"category": "Financial",
		"syntax": "DOLLARDE(fractional_dollar, fraction)",
		"description": "Converts a price written as a fraction (1.02 meaning 1 and 2/16) into a decimal number.",
		"example": "=DOLLARDE(1.02, 16)",
		"result": "1.125"
	},
	{
		"name": "DOLLARFR",
		"category": "Financial",
		"syntax": "DOLLARFR(decimal_dollar, fraction)",
		"description": "Converts a decimal price into a fractional price.",
		"example": "=DOLLARFR(1.125, 16)",
		"result": "1.02"
	},
	{
		"name": "DPRODUCT",
		"category": "Database",
		"syntax": "DPRODUCT(database, field, criteria)",
		"description": "Multiplies the values in a column of a table for the rows that match the criteria.",
		"example": "=DPRODUCT({\"Supplier\", \"Amount\"; \"Acme\", 1250; \"Zenith\", 2410; \"Acme\", 990}, \"Amount\", {\"Supplier\"; \"Acme\"})",
		"result": "1237500"
	},
	{
		"name": "DROP",
		"category": "Lookup & reference",
		"syntax": "DROP(array, rows, [columns])",
		"description": "Removes rows or columns from the start (positive) or end (negative) of an array.",
		"example": "=DROP({1; 2; 3; 4}, 2)",
		"note": "Returns several values; a cell shows the first one.",
		"result": "3"
	},
	{
		"name": "DSTDEV",
		"category": "Database",
		"syntax": "DSTDEV(database, field, criteria)",
		"description": "Returns the sample standard deviation of matching values in a column of a table.",
		"example": "=DSTDEV({\"Supplier\", \"Amount\"; \"Acme\", 1250; \"Zenith\", 2410; \"Acme\", 990}, \"Amount\", {\"Supplier\"; \"Acme\"})",
		"result": "183.8477631"
	},
	{
		"name": "DSTDEVP",
		"category": "Database",
		"syntax": "DSTDEVP(database, field, criteria)",
		"description": "Returns the population standard deviation of matching values in a column of a table.",
		"example": "=DSTDEVP({\"Supplier\", \"Amount\"; \"Acme\", 1250; \"Zenith\", 2410; \"Acme\", 990}, \"Amount\", {\"Supplier\"; \"Acme\"})",
		"result": "130"
	},
	{
		"name": "DSUM",
		"category": "Database",
		"syntax": "DSUM(database, field, criteria)",
		"description": "Adds the values in a column of a table for the rows that match the criteria.",
		"example": "=DSUM({\"Supplier\", \"Amount\"; \"Acme\", 1250; \"Zenith\", 2410; \"Acme\", 990}, \"Amount\", {\"Supplier\"; \"Acme\"})",
		"result": "2240"
	},
	{
		"name": "DVAR",
		"category": "Database",
		"syntax": "DVAR(database, field, criteria)",
		"description": "Returns the sample variance of matching values in a column of a table.",
		"example": "=DVAR({\"Supplier\", \"Amount\"; \"Acme\", 1250; \"Zenith\", 2410; \"Acme\", 990}, \"Amount\", {\"Supplier\"; \"Acme\"})",
		"result": "33800"
	},
	{
		"name": "DVARP",
		"category": "Database",
		"syntax": "DVARP(database, field, criteria)",
		"description": "Returns the population variance of matching values in a column of a table.",
		"example": "=DVARP({\"Supplier\", \"Amount\"; \"Acme\", 1250; \"Zenith\", 2410; \"Acme\", 990}, \"Amount\", {\"Supplier\"; \"Acme\"})",
		"result": "16900"
	},
	{
		"name": "EDATE",
		"category": "Date & time",
		"syntax": "EDATE(start_date, months)",
		"description": "Returns the date a number of months before or after a date.",
		"example": "=EDATE(DATE(2026, 1, 31), 1)",
		"result": "46081 (2026-02-28)",
		"note": "Returns the date as a serial day number."
	},
	{
		"name": "EFFECT",
		"category": "Financial",
		"syntax": "EFFECT(nominal_rate, npery)",
		"description": "Returns the effective annual interest rate for a nominal rate compounded npery times a year.",
		"example": "=EFFECT(0.12, 12)",
		"result": "0.1268250301"
	},
	{
		"name": "EOMONTH",
		"category": "Date & time",
		"syntax": "EOMONTH(start_date, months)",
		"description": "Returns the last day of the month a number of months before or after a date.",
		"example": "=EOMONTH(DATE(2026, 2, 10), 0)",
		"result": "46081 (2026-02-28)",
		"note": "Returns the date as a serial day number."
	},
	{
		"name": "ERF",
		"category": "Engineering",
		"syntax": "ERF(lower_limit, [upper_limit])",
		"description": "Returns the error function between two limits.",
		"example": "=ERF(0.745)",
		"result": "0.7079289201"
	},
	{
		"name": "ERF.PRECISE",
		"category": "Engineering",
		"syntax": "ERF.PRECISE(x)",
		"description": "Returns the error function from 0 to x.",
		"example": "=ERF.PRECISE(1)",
		"result": "0.8427007929"
	},
	{
		"name": "ERFC",
		"category": "Engineering",
		"syntax": "ERFC(x)",
		"description": "Returns the complementary error function.",
		"example": "=ERFC(1)",
		"result": "0.1572992071"
	},
	{
		"name": "ERFC.PRECISE",
		"category": "Engineering",
		"syntax": "ERFC.PRECISE(x)",
		"description": "Returns the complementary error function from x to infinity.",
		"example": "=ERFC.PRECISE(1)",
		"result": "0.1572992071"
	},
	{
		"name": "ERROR.TYPE",
		"category": "Information",
		"syntax": "ERROR.TYPE(error_val)",
		"description": "Returns a number for an error: 2 for #DIV/0!, 7 for #N/A, and so on.",
		"example": "=ERROR.TYPE(1 / 0)",
		"result": "2"
	},
	{
		"name": "EVEN",
		"category": "Math & trig",
		"syntax": "EVEN(number)",
		"description": "Rounds a number away from zero to the nearest even integer.",
		"example": "=EVEN(3.2)",
		"result": "4"
	},
	{
		"name": "EXACT",
		"category": "Text",
		"syntax": "EXACT(text1, text2)",
		"description": "Checks whether two pieces of text are exactly the same, including upper and lower case.",
		"example": "=EXACT(\"Paid\", \"paid\")",
		"result": "FALSE"
	},
	{
		"name": "EXP",
		"category": "Math & trig",
		"syntax": "EXP(number)",
		"description": "Returns e raised to the power of a number.",
		"example": "=EXP(1)",
		"result": "2.718281828"
	},
	{
		"name": "EXPON.DIST",
		"category": "Statistical",
		"syntax": "EXPON.DIST(x, lambda, cumulative)",
		"description": "Returns the exponential distribution.",
		"example": "=EXPON.DIST(0.5, 2, TRUE)",
		"result": "0.6321205588"
	},
	{
		"name": "F.DIST",
		"category": "Statistical",
		"syntax": "F.DIST(x, deg_freedom1, deg_freedom2, cumulative)",
		"description": "Returns the left-tailed F probability distribution.",
		"example": "=F.DIST(2, 5, 10, TRUE)",
		"result": "0.8358050491"
	},
	{
		"name": "F.DIST.RT",
		"category": "Statistical",
		"syntax": "F.DIST.RT(x, deg_freedom1, deg_freedom2)",
		"description": "Returns the right-tailed F probability distribution.",
		"example": "=F.DIST.RT(2, 5, 10)",
		"result": "0.1641949509"
	},
	{
		"name": "F.INV",
		"category": "Statistical",
		"syntax": "F.INV(probability, deg_freedom1, deg_freedom2)",
		"description": "Returns the inverse of the left-tailed F distribution.",
		"example": "=F.INV(0.5, 5, 10)",
		"result": "0.9319331609"
	},
	{
		"name": "F.INV.RT",
		"category": "Statistical",
		"syntax": "F.INV.RT(probability, deg_freedom1, deg_freedom2)",
		"description": "Returns the inverse of the right-tailed F distribution.",
		"example": "=F.INV.RT(0.05, 5, 10)",
		"result": "3.32583453"
	},
	{
		"name": "F.TEST",
		"category": "Statistical",
		"syntax": "F.TEST(array1, array2)",
		"description": "Returns the probability that the variances of two sets of values are not significantly different.",
		"example": "=F.TEST({6, 7, 9, 15, 21}, {20, 28, 31, 38, 40})",
		"result": "0.6483178468"
	},
	{
		"name": "FACT",
		"category": "Math & trig",
		"syntax": "FACT(number)",
		"description": "Returns the factorial of a number (1 × 2 × … × n).",
		"example": "=FACT(5)",
		"result": "120"
	},
	{
		"name": "FACTDOUBLE",
		"category": "Math & trig",
		"syntax": "FACTDOUBLE(number)",
		"description": "Returns the double factorial of a number (n × (n − 2) × …).",
		"example": "=FACTDOUBLE(7)",
		"result": "105"
	},
	{
		"name": "FALSE",
		"category": "Logical",
		"syntax": "FALSE()",
		"description": "Returns the logical value FALSE.",
		"example": "=FALSE()",
		"result": "FALSE"
	},
	{
		"name": "FILTER",
		"category": "Lookup & reference",
		"syntax": "FILTER(array, include, [if_empty])",
		"description": "Returns the items of an array that meet a condition.",
		"example": "=FILTER({10; 25; 40}, {10; 25; 40} > 20)",
		"note": "Returns several values; a cell shows the first one.",
		"result": "25"
	},
	{
		"name": "FIND",
		"category": "Text",
		"syntax": "FIND(find_text, within_text, [start_num])",
		"description": "Returns the position of text inside other text. Case-sensitive.",
		"example": "=FIND(\"-\", \"INV-2026\")",
		"result": "4"
	},
	{
		"name": "FINDB",
		"category": "Text",
		"syntax": "FINDB(find_text, within_text, [start_num])",
		"description": "Like FIND, but counts bytes for double-byte languages.",
		"example": "=FINDB(\"-\", \"INV-2026\")",
		"result": "4"
	},
	{
		"name": "FISHER",
		"category": "Statistical",
		"syntax": "FISHER(x)",
		"description": "Returns the Fisher transformation of a value.",
		"example": "=FISHER(0.75)",
		"result": "0.9729550745"
	},
	{
		"name": "FISHERINV",
		"category": "Statistical",
		"syntax": "FISHERINV(y)",
		"description": "Returns the inverse of the Fisher transformation.",
		"example": "=FISHERINV(0.97)",
		"result": "0.748704287"
	},
	{
		"name": "FIXED",
		"category": "Text",
		"syntax": "FIXED(number, [decimals], [no_commas])",
		"description": "Rounds a number and formats it as text with thousands separators.",
		"example": "=FIXED(1234.567, 1)",
		"result": "1,234.6"
	},
	{
		"name": "FLOOR",
		"category": "Math & trig",
		"syntax": "FLOOR(number, significance)",
		"description": "Rounds a number down to the nearest multiple of significance.",
		"example": "=FLOOR(4.7, 0.5)",
		"result": "4.5"
	},
	{
		"name": "FLOOR.MATH",
		"category": "Math & trig",
		"syntax": "FLOOR.MATH(number, [significance], [mode])",
		"description": "Rounds a number down to the nearest integer or multiple; mode controls how negative numbers round.",
		"example": "=FLOOR.MATH(-4.3)",
		"result": "-5"
	},
	{
		"name": "FLOOR.PRECISE",
		"category": "Math & trig",
		"syntax": "FLOOR.PRECISE(number, [significance])",
		"description": "Rounds a number down to the nearest multiple, whatever its sign.",
		"example": "=FLOOR.PRECISE(-4.3, 2)",
		"result": "-6"
	},
	{
		"name": "FORECAST",
		"category": "Statistical",
		"syntax": "FORECAST(x, known_ys, known_xs)",
		"description": "Predicts a value along a straight-line trend (the older form of FORECAST.LINEAR).",
		"example": "=FORECAST(5, {10, 20, 30, 40}, {1, 2, 3, 4})",
		"result": "50"
	},
	{
		"name": "FORECAST.LINEAR",
		"category": "Statistical",
		"syntax": "FORECAST.LINEAR(x, known_ys, known_xs)",
		"description": "Predicts a future value along a straight-line trend of existing values.",
		"example": "=FORECAST.LINEAR(5, {10, 20, 30, 40}, {1, 2, 3, 4})",
		"result": "50"
	},
	{
		"name": "FORMULATEXT",
		"category": "Lookup & reference",
		"syntax": "FORMULATEXT(reference)",
		"description": "Returns the formula in a referenced cell as text.",
		"example": "=FORMULATEXT(B1)",
		"note": "Takes A1-style cell references, which IntelliSheet sheets don't use, so it is mainly useful with values built inside the formula."
	},
	{
		"name": "FREQUENCY",
		"category": "Statistical",
		"syntax": "FREQUENCY(data_array, bins_array)",
		"description": "Counts how many values fall into each bin; returns one count per bin plus one for values above the last.",
		"example": "=FREQUENCY({1, 3, 5, 7, 9}, {4, 8})",
		"note": "Returns several values; a cell shows the first one.",
		"result": "2"
	},
	{
		"name": "FTEST",
		"category": "Compatibility",
		"syntax": "FTEST(array1, array2)",
		"description": "Older name for F.TEST. Returns the probability that the variances of two sets of values are not significantly different.",
		"example": "=FTEST({6, 7, 9, 15, 21}, {20, 28, 31, 38, 40})",
		"result": "0.6483178468"
	},
	{
		"name": "FV",
		"category": "Financial",
		"syntax": "FV(rate, nper, pmt, [pv], [type])",
		"description": "Returns the future value of an investment with regular, equal payments.",
		"example": "=FV(0.05 / 12, 120, -200)",
		"result": "31056.45589"
	},
	{
		"name": "GAMMA",
		"category": "Statistical",
		"syntax": "GAMMA(number)",
		"description": "Returns the Gamma function value.",
		"example": "=GAMMA(5)",
		"result": "24"
	},
	{
		"name": "GAMMA.DIST",
		"category": "Statistical",
		"syntax": "GAMMA.DIST(x, alpha, beta, cumulative)",
		"description": "Returns the gamma distribution.",
		"example": "=GAMMA.DIST(2, 3, 2, TRUE)",
		"result": "0.08030139707"
	},
	{
		"name": "GAMMA.INV",
		"category": "Statistical",
		"syntax": "GAMMA.INV(probability, alpha, beta)",
		"description": "Returns the inverse of the cumulative gamma distribution.",
		"example": "=GAMMA.INV(0.5, 3, 2)",
		"result": "5.348120627"
	},
	{
		"name": "GAMMAINV",
		"category": "Compatibility",
		"syntax": "GAMMAINV(probability, alpha, beta)",
		"description": "Older name for GAMMA.INV. Returns the inverse of the cumulative gamma distribution.",
		"example": "=GAMMAINV(0.5, 3, 2)",
		"result": "5.348120627"
	},
	{
		"name": "GAMMALN",
		"category": "Statistical",
		"syntax": "GAMMALN(x)",
		"description": "Returns the natural logarithm of the Gamma function.",
		"example": "=GAMMALN(10)",
		"result": "12.80182748"
	},
	{
		"name": "GAMMALN.PRECISE",
		"category": "Statistical",
		"syntax": "GAMMALN.PRECISE(x)",
		"description": "Returns the natural logarithm of the Gamma function.",
		"example": "=GAMMALN.PRECISE(10)",
		"result": "12.80182748"
	},
	{
		"name": "GAUSS",
		"category": "Statistical",
		"syntax": "GAUSS(z)",
		"description": "Returns the probability that a standard normal value falls between the mean and z standard deviations from it.",
		"example": "=GAUSS(1)",
		"result": "0.3413447461"
	},
	{
		"name": "GCD",
		"category": "Math & trig",
		"syntax": "GCD(number1, [number2], …)",
		"description": "Returns the greatest common divisor of whole numbers.",
		"example": "=GCD(24, 36)",
		"result": "12"
	},
	{
		"name": "GEOMEAN",
		"category": "Statistical",
		"syntax": "GEOMEAN(number1, [number2], …)",
		"description": "Returns the geometric mean of positive numbers.",
		"example": "=GEOMEAN(2, 8)",
		"result": "4"
	},
	{
		"name": "GESTEP",
		"category": "Engineering",
		"syntax": "GESTEP(number, [step])",
		"description": "Returns 1 if a number is greater than or equal to step, and 0 otherwise.",
		"example": "=GESTEP(5, 4)",
		"result": "1"
	},
	{
		"name": "GROWTH",
		"category": "Statistical",
		"syntax": "GROWTH(known_ys, [known_xs], [new_xs], [const])",
		"description": "Predicts values along an exponential growth trend.",
		"example": "=GROWTH({10, 20, 40}, {1, 2, 3}, 4)",
		"result": "80"
	},
	{
		"name": "HARMEAN",
		"category": "Statistical",
		"syntax": "HARMEAN(number1, [number2], …)",
		"description": "Returns the harmonic mean of positive numbers.",
		"example": "=HARMEAN(2, 4, 4)",
		"result": "3"
	},
	{
		"name": "HEX2BIN",
		"category": "Engineering",
		"syntax": "HEX2BIN(number, [places])",
		"description": "Converts a hexadecimal number to binary.",
		"example": "=HEX2BIN(\"F\", 8)",
		"result": "00001111"
	},
	{
		"name": "HEX2DEC",
		"category": "Engineering",
		"syntax": "HEX2DEC(number)",
		"description": "Converts a hexadecimal number to decimal.",
		"example": "=HEX2DEC(\"FF\")",
		"result": "255"
	},
	{
		"name": "HEX2OCT",
		"category": "Engineering",
		"syntax": "HEX2OCT(number, [places])",
		"description": "Converts a hexadecimal number to octal.",
		"example": "=HEX2OCT(\"3B\", 4)",
		"result": "0073"
	},
	{
		"name": "HLOOKUP",
		"category": "Lookup & reference",
		"syntax": "HLOOKUP(lookup_value, table_array, row_index_num, [range_lookup])",
		"description": "Looks for a value in the top row of a table and returns the value from a row below it. Use FALSE for an exact match.",
		"example": "=HLOOKUP(\"Feb\", {\"Jan\", \"Feb\", \"Mar\"; 100, 120, 90}, 2, FALSE)",
		"result": "120"
	},
	{
		"name": "HOUR",
		"category": "Date & time",
		"syntax": "HOUR(time)",
		"description": "Returns the hour of a time, from 0 to 23.",
		"example": "=HOUR(TIME(14, 30, 0))",
		"result": "14"
	},
	{
		"name": "HSTACK",
		"category": "Lookup & reference",
		"syntax": "HSTACK(array1, [array2], …)",
		"description": "Joins arrays side by side into one array.",
		"example": "=HSTACK({1; 2}, {3; 4})",
		"note": "Returns several values; a cell shows the first one.",
		"result": "1"
	},
	{
		"name": "HYPERLINK",
		"category": "Lookup & reference",
		"syntax": "HYPERLINK(link_location, [friendly_name])",
		"description": "Creates a link; the cell shows the friendly name.",
		"example": "=HYPERLINK(\"https://example.com\", \"Open site\")",
		"result": "Open site"
	},
	{
		"name": "HYPGEOM.DIST",
		"category": "Statistical",
		"syntax": "HYPGEOM.DIST(sample_s, number_sample, population_s, number_pop, cumulative)",
		"description": "Returns the hypergeometric distribution.",
		"example": "=HYPGEOM.DIST(1, 4, 8, 20, FALSE)",
		"result": "0.3632610939"
	},
	{
		"name": "IF",
		"category": "Logical",
		"syntax": "IF(logical_test, value_if_true, [value_if_false])",
		"description": "Returns one value if a condition is true and another if it is false.",
		"example": "=IF(75 >= 50, \"Pass\", \"Fail\")",
		"sheetExample": "=IF([Status]@row = \"Paid\", 0, [Amount]@row)",
		"result": "Pass"
	},
	{
		"name": "IFERROR",
		"category": "Logical",
		"syntax": "IFERROR(value, value_if_error)",
		"description": "Returns the value you give if a calculation results in an error; otherwise returns the result.",
		"example": "=IFERROR(10 / 0, 0)",
		"sheetExample": "=IFERROR([Amount]@row / [Outstanding]@row, 0)",
		"result": "0"
	},
	{
		"name": "IFNA",
		"category": "Logical",
		"syntax": "IFNA(value, value_if_na)",
		"description": "Returns the value you give if a calculation results in #N/A.",
		"example": "=IFNA(NA(), \"Not found\")",
		"result": "Not found"
	},
	{
		"name": "IFS",
		"category": "Logical",
		"syntax": "IFS(test1, value1, [test2, value2], …)",
		"description": "Checks conditions in order and returns the value for the first one that is TRUE.",
		"example": "=IFS(85 >= 90, \"A\", 85 >= 80, \"B\", TRUE, \"C\")",
		"result": "B"
	},
	{
		"name": "IMABS",
		"category": "Engineering",
		"syntax": "IMABS(inumber)",
		"description": "Returns the absolute value (modulus) of a complex number.",
		"example": "=IMABS(\"3+4i\")",
		"result": "5"
	},
	{
		"name": "IMAGINARY",
		"category": "Engineering",
		"syntax": "IMAGINARY(inumber)",
		"description": "Returns the imaginary coefficient of a complex number.",
		"example": "=IMAGINARY(\"3+4i\")",
		"result": "4"
	},
	{
		"name": "IMARGUMENT",
		"category": "Engineering",
		"syntax": "IMARGUMENT(inumber)",
		"description": "Returns the argument of a complex number: its angle in radians.",
		"example": "=IMARGUMENT(\"3+4i\")",
		"result": "0.927295218"
	},
	{
		"name": "IMCONJUGATE",
		"category": "Engineering",
		"syntax": "IMCONJUGATE(inumber)",
		"description": "Returns the complex conjugate of a complex number.",
		"example": "=IMCONJUGATE(\"3+4i\")",
		"result": "3-4i"
	},
	{
		"name": "IMCOS",
		"category": "Engineering",
		"syntax": "IMCOS(inumber)",
		"description": "Returns the cosine of a complex number.",
		"example": "=IMCOS(\"1+i\")",
		"result": "0.8337300251311492-0.9888977057628651i"
	},
	{
		"name": "IMCOSH",
		"category": "Engineering",
		"syntax": "IMCOSH(inumber)",
		"description": "Returns the hyperbolic cosine of a complex number.",
		"example": "=IMCOSH(\"4+3i\")",
		"result": "-27.034945603074224+3.851153334811777i"
	},
	{
		"name": "IMCOT",
		"category": "Engineering",
		"syntax": "IMCOT(inumber)",
		"description": "Returns the cotangent of a complex number.",
		"example": "=IMCOT(\"4+3i\")",
		"result": "0.004901182394304499-0.9992669278059015i"
	},
	{
		"name": "IMCSC",
		"category": "Engineering",
		"syntax": "IMCSC(inumber)",
		"description": "Returns the cosecant of a complex number.",
		"example": "=IMCSC(\"4+3i\")",
		"result": "-0.0754898329158637+0.0648774713706355i"
	},
	{
		"name": "IMCSCH",
		"category": "Engineering",
		"syntax": "IMCSCH(inumber)",
		"description": "Returns the hyperbolic cosecant of a complex number.",
		"example": "=IMCSCH(\"4+3i\")",
		"result": "-0.03627588962862602-0.005174473184019398i"
	},
	{
		"name": "IMDIV",
		"category": "Engineering",
		"syntax": "IMDIV(inumber1, inumber2)",
		"description": "Divides one complex number by another.",
		"example": "=IMDIV(\"-238+240i\", \"10+24i\")",
		"result": "5+12i"
	},
	{
		"name": "IMEXP",
		"category": "Engineering",
		"syntax": "IMEXP(inumber)",
		"description": "Returns e raised to the power of a complex number.",
		"example": "=IMEXP(\"1+i\")",
		"result": "1.4686939399158854+2.2873552871788427i"
	},
	{
		"name": "IMLN",
		"category": "Engineering",
		"syntax": "IMLN(inumber)",
		"description": "Returns the natural logarithm of a complex number.",
		"example": "=IMLN(\"3+4i\")",
		"result": "1.6094379124341003+0.9272952180016122i"
	},
	{
		"name": "IMLOG10",
		"category": "Engineering",
		"syntax": "IMLOG10(inumber)",
		"description": "Returns the base-10 logarithm of a complex number.",
		"example": "=IMLOG10(\"3+4i\")",
		"result": "0.6989700043360187+0.4027191962733731i"
	},
	{
		"name": "IMLOG2",
		"category": "Engineering",
		"syntax": "IMLOG2(inumber)",
		"description": "Returns the base-2 logarithm of a complex number.",
		"example": "=IMLOG2(\"3+4i\")",
		"result": "2.321928094887362+1.3378042124509761i"
	},
	{
		"name": "IMPOWER",
		"category": "Engineering",
		"syntax": "IMPOWER(inumber, number)",
		"description": "Raises a complex number to a power.",
		"example": "=IMPOWER(\"2+3i\", 3)",
		"result": "-46+9i"
	},
	{
		"name": "IMPRODUCT",
		"category": "Engineering",
		"syntax": "IMPRODUCT(inumber1, [inumber2], …)",
		"description": "Multiplies complex numbers.",
		"example": "=IMPRODUCT(\"3+4i\", \"5-3i\")",
		"result": "27+11i"
	},
	{
		"name": "IMREAL",
		"category": "Engineering",
		"syntax": "IMREAL(inumber)",
		"description": "Returns the real coefficient of a complex number.",
		"example": "=IMREAL(\"6-9i\")",
		"result": "6"
	},
	{
		"name": "IMSEC",
		"category": "Engineering",
		"syntax": "IMSEC(inumber)",
		"description": "Returns the secant of a complex number.",
		"example": "=IMSEC(\"4+3i\")",
		"result": "-0.06529402785794704-0.07522496030277322i"
	},
	{
		"name": "IMSECH",
		"category": "Engineering",
		"syntax": "IMSECH(inumber)",
		"description": "Returns the hyperbolic secant of a complex number.",
		"example": "=IMSECH(\"4+3i\")",
		"result": "-0.03625349691586887-0.005164344607753178i"
	},
	{
		"name": "IMSIN",
		"category": "Engineering",
		"syntax": "IMSIN(inumber)",
		"description": "Returns the sine of a complex number.",
		"example": "=IMSIN(\"4+3i\")",
		"result": "-7.61923172032141-6.5481200409110025i"
	},
	{
		"name": "IMSINH",
		"category": "Engineering",
		"syntax": "IMSINH(inumber)",
		"description": "Returns the hyperbolic sine of a complex number.",
		"example": "=IMSINH(\"4+3i\")",
		"result": "-27.016813258003932+3.853738037919377i"
	},
	{
		"name": "IMSQRT",
		"category": "Engineering",
		"syntax": "IMSQRT(inumber)",
		"description": "Returns the square root of a complex number.",
		"example": "=IMSQRT(\"1+i\")",
		"result": "1.0986841134678098+0.45508986056222733i"
	},
	{
		"name": "IMSUB",
		"category": "Engineering",
		"syntax": "IMSUB(inumber1, inumber2)",
		"description": "Subtracts one complex number from another.",
		"example": "=IMSUB(\"13+4i\", \"5+3i\")",
		"result": "8+i"
	},
	{
		"name": "IMSUM",
		"category": "Engineering",
		"syntax": "IMSUM(inumber1, [inumber2], …)",
		"description": "Adds complex numbers.",
		"example": "=IMSUM(\"3+4i\", \"5-3i\")",
		"result": "8+i"
	},
	{
		"name": "IMTAN",
		"category": "Engineering",
		"syntax": "IMTAN(inumber)",
		"description": "Returns the tangent of a complex number.",
		"example": "=IMTAN(\"4+3i\")",
		"result": "0.004908258067496073+1.0007095360672327i"
	},
	{
		"name": "INDEX",
		"category": "Lookup & reference",
		"syntax": "INDEX(array, row_num, [column_num])",
		"description": "Returns the value at a row and column position in an array or range.",
		"example": "=INDEX({\"a\", \"b\"; \"c\", \"d\"}, 2, 1)",
		"sheetExample": "=INDEX([Supplier]:[Supplier], MATCH(MAX([Amount]:[Amount]), [Amount]:[Amount], 0))",
		"result": "c"
	},
	{
		"name": "INDIRECT",
		"category": "Lookup & reference",
		"syntax": "INDIRECT(ref_text, [a1])",
		"description": "Returns the reference described by text, such as \"B2\".",
		"example": "=INDIRECT(\"B2\")",
		"note": "Takes A1-style cell references, which IntelliSheet sheets don't use, so it is mainly useful with values built inside the formula."
	},
	{
		"name": "INT",
		"category": "Math & trig",
		"syntax": "INT(number)",
		"description": "Rounds a number down to the nearest integer.",
		"example": "=INT(-3.7)",
		"result": "-4"
	},
	{
		"name": "INTERCEPT",
		"category": "Statistical",
		"syntax": "INTERCEPT(known_ys, known_xs)",
		"description": "Returns the point where a straight-line fit crosses the y-axis.",
		"example": "=INTERCEPT({3, 5, 7}, {1, 2, 3})",
		"result": "1"
	},
	{
		"name": "IPMT",
		"category": "Financial",
		"syntax": "IPMT(rate, per, nper, pv, [fv], [type])",
		"description": "Returns the interest part of a loan payment for one period.",
		"example": "=IPMT(0.05 / 12, 1, 360, 250000)",
		"result": "-1041.666667"
	},
	{
		"name": "IRR",
		"category": "Financial",
		"syntax": "IRR(values, [guess])",
		"description": "Returns the internal rate of return for a series of regular cash flows.",
		"example": "=IRR({-10000, 3000, 4200, 6800})",
		"result": "0.1634056007"
	},
	{
		"name": "ISBLANK",
		"category": "Information",
		"syntax": "ISBLANK(value)",
		"description": "Returns TRUE if the value is empty.",
		"example": "=ISBLANK(\"Paid\")",
		"sheetExample": "=ISBLANK([Notes]@row)",
		"result": "FALSE"
	},
	{
		"name": "ISERR",
		"category": "Information",
		"syntax": "ISERR(value)",
		"description": "Returns TRUE if the value is any error except #N/A.",
		"example": "=ISERR(1 / 0)",
		"result": "TRUE"
	},
	{
		"name": "ISERROR",
		"category": "Information",
		"syntax": "ISERROR(value)",
		"description": "Returns TRUE if the value is any error.",
		"example": "=ISERROR(NA())",
		"result": "TRUE"
	},
	{
		"name": "ISEVEN",
		"category": "Information",
		"syntax": "ISEVEN(number)",
		"description": "Returns TRUE if the number is even.",
		"example": "=ISEVEN(4)",
		"result": "TRUE"
	},
	{
		"name": "ISFORMULA",
		"category": "Information",
		"syntax": "ISFORMULA(reference)",
		"description": "Returns TRUE if the referenced cell contains a formula.",
		"example": "=ISFORMULA(B1)",
		"note": "Takes A1-style cell references, which IntelliSheet sheets don't use, so it is mainly useful with values built inside the formula."
	},
	{
		"name": "ISLOGICAL",
		"category": "Information",
		"syntax": "ISLOGICAL(value)",
		"description": "Returns TRUE if the value is TRUE or FALSE.",
		"example": "=ISLOGICAL(TRUE)",
		"result": "TRUE"
	},
	{
		"name": "ISNA",
		"category": "Information",
		"syntax": "ISNA(value)",
		"description": "Returns TRUE if the value is the #N/A error.",
		"example": "=ISNA(NA())",
		"result": "TRUE"
	},
	{
		"name": "ISNONTEXT",
		"category": "Information",
		"syntax": "ISNONTEXT(value)",
		"description": "Returns TRUE if the value is not text.",
		"example": "=ISNONTEXT(42)",
		"result": "TRUE"
	},
	{
		"name": "ISNUMBER",
		"category": "Information",
		"syntax": "ISNUMBER(value)",
		"description": "Returns TRUE if the value is a number. Numbers stored as text return FALSE.",
		"example": "=ISNUMBER(\"42\")",
		"result": "FALSE"
	},
	{
		"name": "ISO.CEILING",
		"category": "Math & trig",
		"syntax": "ISO.CEILING(number, [significance])",
		"description": "Rounds a number up to the nearest multiple, whatever its sign (ISO standard).",
		"example": "=ISO.CEILING(4.3, 2)",
		"result": "6"
	},
	{
		"name": "ISODD",
		"category": "Information",
		"syntax": "ISODD(number)",
		"description": "Returns TRUE if the number is odd.",
		"example": "=ISODD(7)",
		"result": "TRUE"
	},
	{
		"name": "ISOWEEKNUM",
		"category": "Date & time",
		"syntax": "ISOWEEKNUM(date)",
		"description": "Returns the ISO week number of the year for a date.",
		"example": "=ISOWEEKNUM(DATE(2026, 3, 14))",
		"result": "11"
	},
	{
		"name": "ISPMT",
		"category": "Financial",
		"syntax": "ISPMT(rate, per, nper, pv)",
		"description": "Returns the interest paid in a period of a loan with equal principal repayments.",
		"example": "=ISPMT(0.1 / 12, 1, 36, 8000000)",
		"result": "-64814.81481"
	},
	{
		"name": "ISREF",
		"category": "Information",
		"syntax": "ISREF(value)",
		"description": "Returns TRUE if the value is a reference.",
		"example": "=ISREF(B1)",
		"note": "Takes A1-style cell references, which IntelliSheet sheets don't use, so it is mainly useful with values built inside the formula."
	},
	{
		"name": "ISTEXT",
		"category": "Information",
		"syntax": "ISTEXT(value)",
		"description": "Returns TRUE if the value is text.",
		"example": "=ISTEXT(\"Acme\")",
		"result": "TRUE"
	},
	{
		"name": "KURT",
		"category": "Statistical",
		"syntax": "KURT(number1, [number2], …)",
		"description": "Returns the kurtosis of a set of values: how heavy its tails are.",
		"example": "=KURT(3, 4, 5, 2, 3, 4, 5, 6, 4, 7)",
		"result": "-0.1517996372"
	},
	{
		"name": "LAMBDA",
		"category": "Logical",
		"syntax": "LAMBDA([parameter1, …], calculation)",
		"description": "Creates a reusable function from parameters and a calculation. Give it a name with LET, then call it by that name.",
		"example": "=LET(double, LAMBDA(x, x * 2), double(4))",
		"result": "8"
	},
	{
		"name": "LARGE",
		"category": "Statistical",
		"syntax": "LARGE(array, k)",
		"description": "Returns the k-th largest value.",
		"example": "=LARGE({12, 45, 7, 30}, 2)",
		"sheetExample": "=LARGE([Amount]:[Amount], 3)",
		"result": "30"
	},
	{
		"name": "LCM",
		"category": "Math & trig",
		"syntax": "LCM(number1, [number2], …)",
		"description": "Returns the least common multiple of whole numbers.",
		"example": "=LCM(4, 6)",
		"result": "12"
	},
	{
		"name": "LEFT",
		"category": "Text",
		"syntax": "LEFT(text, [num_chars])",
		"description": "Returns the first characters of text.",
		"example": "=LEFT(\"Acme Ltd\", 4)",
		"sheetExample": "=LEFT([Invoice No.]@row, 2)",
		"result": "Acme"
	},
	{
		"name": "LEFTB",
		"category": "Text",
		"syntax": "LEFTB(text, [num_bytes])",
		"description": "Like LEFT, but counts bytes for double-byte languages.",
		"example": "=LEFTB(\"Acme Ltd\", 4)",
		"result": "Acme"
	},
	{
		"name": "LEN",
		"category": "Text",
		"syntax": "LEN(text)",
		"description": "Returns the number of characters in text.",
		"example": "=LEN(\"IntelliSheet\")",
		"sheetExample": "=LEN([Supplier]@row)",
		"result": "12"
	},
	{
		"name": "LENB",
		"category": "Text",
		"syntax": "LENB(text)",
		"description": "Like LEN, but counts bytes for double-byte languages.",
		"example": "=LENB(\"IntelliSheet\")",
		"result": "12"
	},
	{
		"name": "LET",
		"category": "Logical",
		"syntax": "LET(name1, value1, [name2, value2], …, calculation)",
		"description": "Gives names to values inside a formula so the calculation can reuse them.",
		"example": "=LET(price, 120, tax, 0.2, price * (1 + tax))",
		"result": "144"
	},
	{
		"name": "LINEST",
		"category": "Statistical",
		"syntax": "LINEST(known_ys, [known_xs], [const], [stats])",
		"description": "Returns statistics for a straight-line fit, starting with the slope.",
		"example": "=LINEST({3, 5, 7}, {1, 2, 3})",
		"note": "Returns several values; a cell shows the first one.",
		"result": "2"
	},
	{
		"name": "LN",
		"category": "Math & trig",
		"syntax": "LN(number)",
		"description": "Returns the natural logarithm of a number.",
		"example": "=LN(EXP(2))",
		"result": "2"
	},
	{
		"name": "LOG",
		"category": "Math & trig",
		"syntax": "LOG(number, [base])",
		"description": "Returns the logarithm of a number to the base you give (10 if left out).",
		"example": "=LOG(8, 2)",
		"result": "3"
	},
	{
		"name": "LOG10",
		"category": "Math & trig",
		"syntax": "LOG10(number)",
		"description": "Returns the base-10 logarithm of a number.",
		"example": "=LOG10(1000)",
		"result": "3"
	},
	{
		"name": "LOGEST",
		"category": "Statistical",
		"syntax": "LOGEST(known_ys, [known_xs], [const], [stats])",
		"description": "Returns statistics for an exponential curve fit.",
		"example": "=LOGEST({10, 20, 40}, {1, 2, 3})",
		"note": "Returns several values; a cell shows the first one.",
		"result": "2"
	},
	{
		"name": "LOGNORM.DIST",
		"category": "Statistical",
		"syntax": "LOGNORM.DIST(x, mean, standard_dev, cumulative)",
		"description": "Returns the lognormal distribution.",
		"example": "=LOGNORM.DIST(4, 3.5, 1.2, TRUE)",
		"result": "0.03908355571"
	},
	{
		"name": "LOGNORM.INV",
		"category": "Statistical",
		"syntax": "LOGNORM.INV(probability, mean, standard_dev)",
		"description": "Returns the inverse of the cumulative lognormal distribution.",
		"example": "=LOGNORM.INV(0.039, 3.5, 1.2)",
		"result": "3.995255932"
	},
	{
		"name": "LOOKUP",
		"category": "Lookup & reference",
		"syntax": "LOOKUP(lookup_value, lookup_vector, [result_vector])",
		"description": "Looks up a value in one row or column and returns the matching value from another. The lookup list must be sorted.",
		"example": "=LOOKUP(3, {1, 2, 3}, {\"Bronze\", \"Silver\", \"Gold\"})",
		"result": "Gold"
	},
	{
		"name": "LOWER",
		"category": "Text",
		"syntax": "LOWER(text)",
		"description": "Converts text to lowercase.",
		"example": "=LOWER(\"PAID\")",
		"result": "paid"
	},
	{
		"name": "MATCH",
		"category": "Lookup & reference",
		"syntax": "MATCH(lookup_value, lookup_array, [match_type])",
		"description": "Returns the position of a value in a list. Use 0 for an exact match.",
		"example": "=MATCH(\"Mar\", {\"Jan\", \"Feb\", \"Mar\"}, 0)",
		"result": "3"
	},
	{
		"name": "MAX",
		"category": "Statistical",
		"syntax": "MAX(number1, [number2], …)",
		"description": "Returns the largest number.",
		"example": "=MAX(12, 45, 7)",
		"sheetExample": "=MAX([Amount]:[Amount])",
		"result": "45"
	},
	{
		"name": "MAXA",
		"category": "Statistical",
		"syntax": "MAXA(value1, [value2], …)",
		"description": "Returns the largest value, counting TRUE as 1 and text or FALSE as 0.",
		"example": "=MAXA(0.5, TRUE)",
		"result": "1"
	},
	{
		"name": "MAXIFS",
		"category": "Statistical",
		"syntax": "MAXIFS(max_range, criteria_range1, criteria1, …)",
		"description": "Returns the largest value among those that meet the conditions.",
		"example": "=MAXIFS({100, 250, 175}, {\"a\", \"b\", \"a\"}, \"a\")",
		"sheetExample": "=MAXIFS([Amount]:[Amount], [Status]:[Status], \"Unpaid\")",
		"result": "175"
	},
	{
		"name": "MEDIAN",
		"category": "Statistical",
		"syntax": "MEDIAN(number1, [number2], …)",
		"description": "Returns the middle value of a set of numbers.",
		"example": "=MEDIAN(3, 9, 4, 7)",
		"sheetExample": "=MEDIAN([Amount]:[Amount])",
		"result": "5.5"
	},
	{
		"name": "MID",
		"category": "Text",
		"syntax": "MID(text, start_num, num_chars)",
		"description": "Returns characters from the middle of text, starting at a position.",
		"example": "=MID(\"INV-2026-004\", 5, 4)",
		"result": "2026"
	},
	{
		"name": "MIDB",
		"category": "Text",
		"syntax": "MIDB(text, start_num, num_bytes)",
		"description": "Like MID, but counts bytes for double-byte languages.",
		"example": "=MIDB(\"INV-2026-004\", 5, 4)",
		"result": "2026"
	},
	{
		"name": "MIN",
		"category": "Statistical",
		"syntax": "MIN(number1, [number2], …)",
		"description": "Returns the smallest number.",
		"example": "=MIN(12, 45, 7)",
		"sheetExample": "=MIN([Amount]:[Amount])",
		"result": "7"
	},
	{
		"name": "MINA",
		"category": "Statistical",
		"syntax": "MINA(value1, [value2], …)",
		"description": "Returns the smallest value, counting TRUE as 1 and text or FALSE as 0.",
		"example": "=MINA(0.5, FALSE)",
		"result": "0"
	},
	{
		"name": "MINIFS",
		"category": "Statistical",
		"syntax": "MINIFS(min_range, criteria_range1, criteria1, …)",
		"description": "Returns the smallest value among those that meet the conditions.",
		"example": "=MINIFS({100, 250, 175}, {\"a\", \"b\", \"a\"}, \"a\")",
		"sheetExample": "=MINIFS([Amount]:[Amount], [Status]:[Status], \"Unpaid\")",
		"result": "100"
	},
	{
		"name": "MINUTE",
		"category": "Date & time",
		"syntax": "MINUTE(time)",
		"description": "Returns the minute of a time, from 0 to 59.",
		"example": "=MINUTE(TIME(14, 30, 0))",
		"result": "30"
	},
	{
		"name": "MIRR",
		"category": "Financial",
		"syntax": "MIRR(values, finance_rate, reinvest_rate)",
		"description": "Returns the modified internal rate of return, using separate borrowing and reinvestment rates.",
		"example": "=MIRR({-10000, 3000, 4200, 6800}, 0.1, 0.12)",
		"result": "0.1514713366"
	},
	{
		"name": "MOD",
		"category": "Math & trig",
		"syntax": "MOD(number, divisor)",
		"description": "Returns the remainder after dividing a number by a divisor.",
		"example": "=MOD(10, 3)",
		"result": "1"
	},
	{
		"name": "MODE",
		"category": "Compatibility",
		"syntax": "MODE(number1, [number2], …)",
		"description": "Older name for MODE.SNGL. Returns the most frequent value in a set.",
		"example": "=MODE(1, 2, 2, 3)",
		"result": "2"
	},
	{
		"name": "MODE.MULT",
		"category": "Statistical",
		"syntax": "MODE.MULT(number1, [number2], …)",
		"description": "Returns every most-frequent value in a set.",
		"example": "=MODE.MULT({1, 2, 2, 3, 3})",
		"note": "Returns several values; a cell shows the first one.",
		"result": "2"
	},
	{
		"name": "MODE.SNGL",
		"category": "Statistical",
		"syntax": "MODE.SNGL(number1, [number2], …)",
		"description": "Returns the most frequent value in a set.",
		"example": "=MODE.SNGL(1, 2, 2, 3)",
		"result": "2"
	},
	{
		"name": "MONTH",
		"category": "Date & time",
		"syntax": "MONTH(date)",
		"description": "Returns the month of a date, from 1 (January) to 12 (December).",
		"example": "=MONTH(DATE(2026, 3, 14))",
		"result": "3"
	},
	{
		"name": "MROUND",
		"category": "Math & trig",
		"syntax": "MROUND(number, multiple)",
		"description": "Rounds a number to the nearest multiple.",
		"example": "=MROUND(17, 5)",
		"result": "15"
	},
	{
		"name": "MULTINOMIAL",
		"category": "Math & trig",
		"syntax": "MULTINOMIAL(number1, [number2], …)",
		"description": "Returns the multinomial coefficient of a set of numbers.",
		"example": "=MULTINOMIAL(2, 3, 4)",
		"result": "1260"
	},
	{
		"name": "N",
		"category": "Information",
		"syntax": "N(value)",
		"description": "Converts a value to a number: TRUE becomes 1 and text becomes 0.",
		"example": "=N(TRUE)",
		"result": "1"
	},
	{
		"name": "NA",
		"category": "Information",
		"syntax": "NA()",
		"description": "Returns the #N/A error, meaning \"no value available\".",
		"example": "=NA()",
		"result": "#N/A"
	},
	{
		"name": "NEGBINOM.DIST",
		"category": "Statistical",
		"syntax": "NEGBINOM.DIST(number_f, number_s, probability_s, cumulative)",
		"description": "Returns the negative binomial distribution.",
		"example": "=NEGBINOM.DIST(10, 5, 0.25, FALSE)",
		"result": "0.05504866038"
	},
	{
		"name": "NETWORKDAYS",
		"category": "Date & time",
		"syntax": "NETWORKDAYS(start_date, end_date, [holidays])",
		"description": "Returns the number of working days, Monday to Friday, between two dates (both included).",
		"example": "=NETWORKDAYS(DATE(2026, 9, 1), DATE(2026, 9, 30))",
		"result": "22"
	},
	{
		"name": "NETWORKDAYS.INTL",
		"category": "Date & time",
		"syntax": "NETWORKDAYS.INTL(start_date, end_date, [weekend], [holidays])",
		"description": "Returns the number of working days between two dates with the weekend you choose (7 means Friday and Saturday).",
		"example": "=NETWORKDAYS.INTL(DATE(2026, 9, 1), DATE(2026, 9, 30), 7)",
		"result": "22"
	},
	{
		"name": "NOMINAL",
		"category": "Financial",
		"syntax": "NOMINAL(effect_rate, npery)",
		"description": "Returns the nominal annual rate for an effective rate.",
		"example": "=NOMINAL(0.1268, 12)",
		"result": "0.1199775647"
	},
	{
		"name": "NORM.DIST",
		"category": "Statistical",
		"syntax": "NORM.DIST(x, mean, standard_dev, cumulative)",
		"description": "Returns the normal distribution for a mean and standard deviation.",
		"example": "=NORM.DIST(42, 40, 1.5, TRUE)",
		"result": "0.9087887803"
	},
	{
		"name": "NORM.INV",
		"category": "Statistical",
		"syntax": "NORM.INV(probability, mean, standard_dev)",
		"description": "Returns the inverse of the normal cumulative distribution.",
		"example": "=NORM.INV(0.9, 40, 1.5)",
		"result": "41.92232735"
	},
	{
		"name": "NORM.S.DIST",
		"category": "Statistical",
		"syntax": "NORM.S.DIST(z, cumulative)",
		"description": "Returns the standard normal distribution (mean 0, standard deviation 1).",
		"example": "=NORM.S.DIST(1.96, TRUE)",
		"result": "0.9750021049"
	},
	{
		"name": "NORM.S.INV",
		"category": "Statistical",
		"syntax": "NORM.S.INV(probability)",
		"description": "Returns the inverse of the standard normal cumulative distribution.",
		"example": "=NORM.S.INV(0.975)",
		"result": "1.959963986"
	},
	{
		"name": "NOT",
		"category": "Logical",
		"syntax": "NOT(logical)",
		"description": "Reverses a logical value: TRUE becomes FALSE and FALSE becomes TRUE.",
		"example": "=NOT(TRUE)",
		"result": "FALSE"
	},
	{
		"name": "NOW",
		"category": "Date & time",
		"syntax": "NOW()",
		"description": "Returns the current date and time.",
		"example": "=NOW()",
		"note": "Changes each time the sheet recalculates."
	},
	{
		"name": "NPER",
		"category": "Financial",
		"syntax": "NPER(rate, pmt, pv, [fv], [type])",
		"description": "Returns the number of payment periods needed for a loan or investment.",
		"example": "=NPER(0.01, -100, 1000)",
		"result": "10.58864446"
	},
	{
		"name": "NPV",
		"category": "Financial",
		"syntax": "NPV(rate, value1, [value2], …)",
		"description": "Returns the net present value of future cash flows at a discount rate.",
		"example": "=NPV(0.1, -10000, 3000, 4200, 6800)",
		"result": "1188.443412"
	},
	{
		"name": "NUMBERVALUE",
		"category": "Text",
		"syntax": "NUMBERVALUE(text, [decimal_separator], [group_separator])",
		"description": "Converts text to a number using the separators you give, whatever the locale.",
		"example": "=NUMBERVALUE(\"1.234,5\", \",\", \".\")",
		"result": "1234.5"
	},
	{
		"name": "OCT2BIN",
		"category": "Engineering",
		"syntax": "OCT2BIN(number, [places])",
		"description": "Converts an octal number to binary.",
		"example": "=OCT2BIN(\"3\", 3)",
		"result": "011"
	},
	{
		"name": "OCT2DEC",
		"category": "Engineering",
		"syntax": "OCT2DEC(number)",
		"description": "Converts an octal number to decimal.",
		"example": "=OCT2DEC(\"54\")",
		"result": "44"
	},
	{
		"name": "OCT2HEX",
		"category": "Engineering",
		"syntax": "OCT2HEX(number, [places])",
		"description": "Converts an octal number to hexadecimal.",
		"example": "=OCT2HEX(\"100\", 4)",
		"result": "0040"
	},
	{
		"name": "ODD",
		"category": "Math & trig",
		"syntax": "ODD(number)",
		"description": "Rounds a number away from zero to the nearest odd integer.",
		"example": "=ODD(2.5)",
		"result": "3"
	},
	{
		"name": "OFFSET",
		"category": "Lookup & reference",
		"syntax": "OFFSET(reference, rows, cols, [height], [width])",
		"description": "Returns a reference a number of rows and columns away from a starting cell.",
		"example": "=OFFSET(A1, 2, 1)",
		"note": "Takes A1-style cell references, which IntelliSheet sheets don't use, so it is mainly useful with values built inside the formula."
	},
	{
		"name": "OR",
		"category": "Logical",
		"syntax": "OR(logical1, [logical2], …)",
		"description": "Returns TRUE if any of its arguments is TRUE.",
		"example": "=OR(1 > 2, 3 > 2)",
		"sheetExample": "=OR([Status]@row = \"Disputed\", [Amount]@row > 10000)",
		"result": "TRUE"
	},
	{
		"name": "PDURATION",
		"category": "Financial",
		"syntax": "PDURATION(rate, pv, fv)",
		"description": "Returns the number of periods an investment needs to grow to a value.",
		"example": "=PDURATION(0.025, 2000, 2200)",
		"result": "3.859866163"
	},
	{
		"name": "PEARSON",
		"category": "Statistical",
		"syntax": "PEARSON(array1, array2)",
		"description": "Returns the Pearson correlation coefficient of two sets of values.",
		"example": "=PEARSON({1, 2, 3, 4}, {2, 4, 5, 9})",
		"result": "0.9647638212"
	},
	{
		"name": "PERCENTILE",
		"category": "Compatibility",
		"syntax": "PERCENTILE(array, k)",
		"description": "Older name for PERCENTILE.INC. Returns the k-th percentile, for k from 0 to 1 (inclusive).",
		"example": "=PERCENTILE({1, 2, 3, 4}, 0.75)",
		"result": "3.25"
	},
	{
		"name": "PERCENTILE.EXC",
		"category": "Statistical",
		"syntax": "PERCENTILE.EXC(array, k)",
		"description": "Returns the k-th percentile, for k between 0 and 1 (exclusive).",
		"example": "=PERCENTILE.EXC({1, 2, 3, 4, 5, 6, 7, 8, 9}, 0.25)",
		"result": "2.5"
	},
	{
		"name": "PERCENTILE.INC",
		"category": "Statistical",
		"syntax": "PERCENTILE.INC(array, k)",
		"description": "Returns the k-th percentile, for k from 0 to 1 (inclusive).",
		"example": "=PERCENTILE.INC({1, 2, 3, 4}, 0.75)",
		"result": "3.25"
	},
	{
		"name": "PERCENTRANK",
		"category": "Compatibility",
		"syntax": "PERCENTRANK(array, x, [significance])",
		"description": "Older name for PERCENTRANK.INC. Returns the rank of a value as a percentage of the set (inclusive).",
		"example": "=PERCENTRANK({1, 2, 3, 4, 5}, 3)",
		"result": "0.5"
	},
	{
		"name": "PERCENTRANK.EXC",
		"category": "Statistical",
		"syntax": "PERCENTRANK.EXC(array, x, [significance])",
		"description": "Returns the rank of a value as a percentage of the set (exclusive).",
		"example": "=PERCENTRANK.EXC({1, 2, 3, 4, 5}, 3)",
		"result": "0.5"
	},
	{
		"name": "PERCENTRANK.INC",
		"category": "Statistical",
		"syntax": "PERCENTRANK.INC(array, x, [significance])",
		"description": "Returns the rank of a value as a percentage of the set (inclusive).",
		"example": "=PERCENTRANK.INC({1, 2, 3, 4, 5}, 3)",
		"result": "0.5"
	},
	{
		"name": "PERMUT",
		"category": "Statistical",
		"syntax": "PERMUT(number, number_chosen)",
		"description": "Returns how many ways you can arrange items chosen from a set when order matters.",
		"example": "=PERMUT(8, 3)",
		"result": "336"
	},
	{
		"name": "PHI",
		"category": "Statistical",
		"syntax": "PHI(x)",
		"description": "Returns the density of the standard normal distribution at x.",
		"example": "=PHI(0.75)",
		"result": "0.3011374322"
	},
	{
		"name": "PI",
		"category": "Math & trig",
		"syntax": "PI()",
		"description": "Returns pi (3.14159…) to 15 digits.",
		"example": "=PI()",
		"result": "3.141592654"
	},
	{
		"name": "PMT",
		"category": "Financial",
		"syntax": "PMT(rate, nper, pv, [fv], [type])",
		"description": "Returns the regular payment for a loan with a constant interest rate.",
		"example": "=PMT(0.05 / 12, 360, 250000)",
		"result": "-1342.054058"
	},
	{
		"name": "POISSON.DIST",
		"category": "Statistical",
		"syntax": "POISSON.DIST(x, mean, cumulative)",
		"description": "Returns the Poisson distribution.",
		"example": "=POISSON.DIST(2, 5, FALSE)",
		"result": "0.08422433749"
	},
	{
		"name": "POWER",
		"category": "Math & trig",
		"syntax": "POWER(number, power)",
		"description": "Returns a number raised to a power.",
		"example": "=POWER(2, 10)",
		"result": "1024"
	},
	{
		"name": "PPMT",
		"category": "Financial",
		"syntax": "PPMT(rate, per, nper, pv, [fv], [type])",
		"description": "Returns the principal part of a loan payment for one period.",
		"example": "=PPMT(0.05 / 12, 1, 360, 250000)",
		"result": "-300.3873909"
	},
	{
		"name": "PRICE",
		"category": "Financial",
		"syntax": "PRICE(settlement, maturity, rate, yld, redemption, frequency, [basis])",
		"description": "Returns the price per 100 of face value of a security that pays interest periodically.",
		"example": "=PRICE(DATE(2026, 2, 15), DATE(2034, 11, 15), 0.0575, 0.065, 100, 2)",
		"result": "95.0428744"
	},
	{
		"name": "PRODUCT",
		"category": "Math & trig",
		"syntax": "PRODUCT(number1, [number2], …)",
		"description": "Multiplies all of its arguments together.",
		"example": "=PRODUCT(2, 3, 4)",
		"result": "24"
	},
	{
		"name": "PROPER",
		"category": "Text",
		"syntax": "PROPER(text)",
		"description": "Capitalises the first letter of each word.",
		"example": "=PROPER(\"zenith logistics\")",
		"sheetExample": "=PROPER([Supplier]@row)",
		"result": "Zenith Logistics"
	},
	{
		"name": "PV",
		"category": "Financial",
		"syntax": "PV(rate, nper, pmt, [fv], [type])",
		"description": "Returns the present value of a series of future payments.",
		"example": "=PV(0.05 / 12, 240, -1500)",
		"result": "227287.9696"
	},
	{
		"name": "QUARTILE",
		"category": "Compatibility",
		"syntax": "QUARTILE(array, quart)",
		"description": "Older name for QUARTILE.INC. Returns a quartile of a set of values (inclusive method).",
		"example": "=QUARTILE({1, 2, 4, 7, 8, 9, 10, 12}, 1)",
		"result": "3.5"
	},
	{
		"name": "QUARTILE.EXC",
		"category": "Statistical",
		"syntax": "QUARTILE.EXC(array, quart)",
		"description": "Returns a quartile of a set of values (exclusive method).",
		"example": "=QUARTILE.EXC({6, 7, 15, 36, 39, 40, 41, 42, 43, 47, 49}, 1)",
		"result": "15"
	},
	{
		"name": "QUARTILE.INC",
		"category": "Statistical",
		"syntax": "QUARTILE.INC(array, quart)",
		"description": "Returns a quartile of a set of values (inclusive method).",
		"example": "=QUARTILE.INC({1, 2, 4, 7, 8, 9, 10, 12}, 1)",
		"result": "3.5"
	},
	{
		"name": "QUOTIENT",
		"category": "Math & trig",
		"syntax": "QUOTIENT(numerator, denominator)",
		"description": "Returns the whole-number part of a division.",
		"example": "=QUOTIENT(17, 5)",
		"result": "3"
	},
	{
		"name": "RADIANS",
		"category": "Math & trig",
		"syntax": "RADIANS(angle)",
		"description": "Converts degrees to radians.",
		"example": "=RADIANS(180)",
		"result": "3.141592654"
	},
	{
		"name": "RAND",
		"category": "Math & trig",
		"syntax": "RAND()",
		"description": "Returns a random number from 0 up to 1.",
		"example": "=RAND()",
		"note": "Changes each time the sheet recalculates."
	},
	{
		"name": "RANDARRAY",
		"category": "Math & trig",
		"syntax": "RANDARRAY([rows], [columns], [min], [max], [whole_number])",
		"description": "Returns an array of random numbers.",
		"example": "=RANDARRAY(3, 1, 1, 100, TRUE)",
		"note": "Returns several values; a cell shows the first one. Changes each time the sheet recalculates."
	},
	{
		"name": "RANDBETWEEN",
		"category": "Math & trig",
		"syntax": "RANDBETWEEN(bottom, top)",
		"description": "Returns a random whole number between two values.",
		"example": "=RANDBETWEEN(1, 6)",
		"note": "Changes each time the sheet recalculates."
	},
	{
		"name": "RANK",
		"category": "Compatibility",
		"syntax": "RANK(number, ref, [order])",
		"description": "Older name for RANK.EQ. Returns the rank of a number in a list; ties share the top rank. Largest is 1 by default.",
		"example": "=RANK(20, {10, 20, 20, 30})",
		"result": "2"
	},
	{
		"name": "RANK.AVG",
		"category": "Statistical",
		"syntax": "RANK.AVG(number, ref, [order])",
		"description": "Returns the rank of a number in a list; ties get their average rank.",
		"example": "=RANK.AVG(20, {10, 20, 20, 30})",
		"result": "2.5"
	},
	{
		"name": "RANK.EQ",
		"category": "Statistical",
		"syntax": "RANK.EQ(number, ref, [order])",
		"description": "Returns the rank of a number in a list; ties share the top rank. Largest is 1 by default.",
		"example": "=RANK.EQ(20, {10, 20, 20, 30})",
		"sheetExample": "=RANK.EQ([Amount]@row, [Amount]:[Amount])",
		"result": "2"
	},
	{
		"name": "RATE",
		"category": "Financial",
		"syntax": "RATE(nper, pmt, pv, [fv], [type], [guess])",
		"description": "Returns the interest rate per period of a loan or annuity.",
		"example": "=RATE(48, -200, 8000)",
		"result": "0.007701472488"
	},
	{
		"name": "REPLACE",
		"category": "Text",
		"syntax": "REPLACE(old_text, start_num, num_chars, new_text)",
		"description": "Replaces part of text, by position, with new text.",
		"example": "=REPLACE(\"2025-Q4\", 1, 4, \"2026\")",
		"result": "2026-Q4"
	},
	{
		"name": "REPLACEB",
		"category": "Text",
		"syntax": "REPLACEB(old_text, start_num, num_bytes, new_text)",
		"description": "Like REPLACE, but counts bytes for double-byte languages.",
		"example": "=REPLACEB(\"2025-Q4\", 1, 4, \"2026\")",
		"result": "2026-Q4"
	},
	{
		"name": "REPT",
		"category": "Text",
		"syntax": "REPT(text, number_times)",
		"description": "Repeats text a number of times.",
		"example": "=REPT(\"★\", 4)",
		"result": "★★★★"
	},
	{
		"name": "RIGHT",
		"category": "Text",
		"syntax": "RIGHT(text, [num_chars])",
		"description": "Returns the last characters of text.",
		"example": "=RIGHT(\"INV-2026\", 4)",
		"result": "2026"
	},
	{
		"name": "RIGHTB",
		"category": "Text",
		"syntax": "RIGHTB(text, [num_bytes])",
		"description": "Like RIGHT, but counts bytes for double-byte languages.",
		"example": "=RIGHTB(\"INV-2026\", 4)",
		"result": "2026"
	},
	{
		"name": "ROMAN",
		"category": "Math & trig",
		"syntax": "ROMAN(number, [form])",
		"description": "Converts a number to a Roman numeral, as text.",
		"example": "=ROMAN(2026)",
		"result": "MMXXVI"
	},
	{
		"name": "ROUND",
		"category": "Math & trig",
		"syntax": "ROUND(number, num_digits)",
		"description": "Rounds a number to the number of digits you give.",
		"example": "=ROUND(3.14159, 2)",
		"sheetExample": "=ROUND([Amount]@row * 1.075, 2)",
		"result": "3.14"
	},
	{
		"name": "ROUNDDOWN",
		"category": "Math & trig",
		"syntax": "ROUNDDOWN(number, num_digits)",
		"description": "Rounds a number down, toward zero.",
		"example": "=ROUNDDOWN(3.789, 1)",
		"result": "3.7"
	},
	{
		"name": "ROUNDUP",
		"category": "Math & trig",
		"syntax": "ROUNDUP(number, num_digits)",
		"description": "Rounds a number up, away from zero.",
		"example": "=ROUNDUP(3.211, 1)",
		"result": "3.3"
	},
	{
		"name": "ROW",
		"category": "Lookup & reference",
		"syntax": "ROW([reference])",
		"description": "Returns the row number of a reference.",
		"example": "=ROW(C5)",
		"note": "Takes A1-style cell references, which IntelliSheet sheets don't use, so it is mainly useful with values built inside the formula.",
		"result": "5"
	},
	{
		"name": "ROWS",
		"category": "Lookup & reference",
		"syntax": "ROWS(array)",
		"description": "Returns the number of rows in an array or range.",
		"example": "=ROWS({1; 2; 3})",
		"result": "3"
	},
	{
		"name": "RRI",
		"category": "Financial",
		"syntax": "RRI(nper, pv, fv)",
		"description": "Returns the equivalent interest rate for an investment to grow from pv to fv.",
		"example": "=RRI(96, 10000, 11000)",
		"result": "0.0009933073763"
	},
	{
		"name": "RSQ",
		"category": "Statistical",
		"syntax": "RSQ(known_ys, known_xs)",
		"description": "Returns the square of the Pearson correlation coefficient (R²).",
		"example": "=RSQ({2, 4, 5, 9}, {1, 2, 3, 4})",
		"result": "0.9307692308"
	},
	{
		"name": "SEARCH",
		"category": "Text",
		"syntax": "SEARCH(find_text, within_text, [start_num])",
		"description": "Returns the position of text inside other text. Not case-sensitive, and allows ? and * wildcards.",
		"example": "=SEARCH(\"ltd\", \"Acme Ltd\")",
		"result": "6"
	},
	{
		"name": "SEARCHB",
		"category": "Text",
		"syntax": "SEARCHB(find_text, within_text, [start_num])",
		"description": "Like SEARCH, but counts bytes for double-byte languages.",
		"example": "=SEARCHB(\"ltd\", \"Acme Ltd\")",
		"result": "6"
	},
	{
		"name": "SEC",
		"category": "Math & trig",
		"syntax": "SEC(number)",
		"description": "Returns the secant of an angle given in radians.",
		"example": "=SEC(1)",
		"result": "1.850815718"
	},
	{
		"name": "SECH",
		"category": "Math & trig",
		"syntax": "SECH(number)",
		"description": "Returns the hyperbolic secant of a number.",
		"example": "=SECH(1)",
		"result": "0.6480542737"
	},
	{
		"name": "SECOND",
		"category": "Date & time",
		"syntax": "SECOND(time)",
		"description": "Returns the second of a time, from 0 to 59.",
		"example": "=SECOND(TIME(14, 30, 45))",
		"result": "45"
	},
	{
		"name": "SEQUENCE",
		"category": "Math & trig",
		"syntax": "SEQUENCE(rows, [columns], [start], [step])",
		"description": "Returns a list of numbers in sequence.",
		"example": "=SEQUENCE(5, 1, 10, 10)",
		"note": "Returns several values; a cell shows the first one.",
		"result": "10"
	},
	{
		"name": "SERIESSUM",
		"category": "Math & trig",
		"syntax": "SERIESSUM(x, n, m, coefficients)",
		"description": "Returns the sum of a power series.",
		"example": "=SERIESSUM(2, 0, 1, {1, 1, 1})",
		"result": "7"
	},
	{
		"name": "SHEET",
		"category": "Information",
		"syntax": "SHEET([value])",
		"description": "Returns the sheet number of a reference.",
		"example": "=SHEET()",
		"note": "Takes A1-style cell references, which IntelliSheet sheets don't use, so it is mainly useful with values built inside the formula."
	},
	{
		"name": "SHEETS",
		"category": "Information",
		"syntax": "SHEETS([reference])",
		"description": "Returns the number of sheets in a reference.",
		"example": "=SHEETS()",
		"note": "Takes A1-style cell references, which IntelliSheet sheets don't use, so it is mainly useful with values built inside the formula."
	},
	{
		"name": "SIGN",
		"category": "Math & trig",
		"syntax": "SIGN(number)",
		"description": "Returns 1 for a positive number, 0 for zero and -1 for a negative number.",
		"example": "=SIGN(-12)",
		"result": "-1"
	},
	{
		"name": "SIN",
		"category": "Math & trig",
		"syntax": "SIN(number)",
		"description": "Returns the sine of an angle given in radians.",
		"example": "=SIN(PI() / 2)",
		"result": "1"
	},
	{
		"name": "SINH",
		"category": "Math & trig",
		"syntax": "SINH(number)",
		"description": "Returns the hyperbolic sine of a number.",
		"example": "=SINH(1)",
		"result": "1.175201194"
	},
	{
		"name": "SKEW",
		"category": "Statistical",
		"syntax": "SKEW(number1, [number2], …)",
		"description": "Returns the skewness of a sample: how lopsided its distribution is.",
		"example": "=SKEW(3, 4, 5, 2, 3, 4, 5, 6, 4, 7)",
		"result": "0.3595430714"
	},
	{
		"name": "SKEW.P",
		"category": "Statistical",
		"syntax": "SKEW.P(number1, [number2], …)",
		"description": "Returns the skewness of a whole population.",
		"example": "=SKEW.P(3, 4, 5, 2, 3, 4, 5, 6, 4, 7)",
		"result": "0.3031933394"
	},
	{
		"name": "SLN",
		"category": "Financial",
		"syntax": "SLN(cost, salvage, life)",
		"description": "Returns straight-line depreciation for one period.",
		"example": "=SLN(30000, 7500, 10)",
		"result": "2250"
	},
	{
		"name": "SLOPE",
		"category": "Statistical",
		"syntax": "SLOPE(known_ys, known_xs)",
		"description": "Returns the slope of a straight-line fit.",
		"example": "=SLOPE({3, 5, 7}, {1, 2, 3})",
		"result": "2"
	},
	{
		"name": "SMALL",
		"category": "Statistical",
		"syntax": "SMALL(array, k)",
		"description": "Returns the k-th smallest value.",
		"example": "=SMALL({12, 45, 7, 30}, 2)",
		"sheetExample": "=SMALL([Amount]:[Amount], 1)",
		"result": "12"
	},
	{
		"name": "SORT",
		"category": "Lookup & reference",
		"syntax": "SORT(array, [sort_index], [sort_order], [by_col])",
		"description": "Sorts the contents of an array; sort_order -1 sorts largest first.",
		"example": "=SORT({30; 10; 20})",
		"note": "Returns several values; a cell shows the first one.",
		"result": "10"
	},
	{
		"name": "SORTBY",
		"category": "Lookup & reference",
		"syntax": "SORTBY(array, by_array1, [sort_order1], …)",
		"description": "Sorts an array by the values of another array.",
		"example": "=SORTBY({\"c\"; \"a\"; \"b\"}, {3; 1; 2})",
		"note": "Returns several values; a cell shows the first one.",
		"result": "a"
	},
	{
		"name": "SQRT",
		"category": "Math & trig",
		"syntax": "SQRT(number)",
		"description": "Returns the positive square root of a number.",
		"example": "=SQRT(144)",
		"result": "12"
	},
	{
		"name": "SQRTPI",
		"category": "Math & trig",
		"syntax": "SQRTPI(number)",
		"description": "Returns the square root of (number × pi).",
		"example": "=SQRTPI(2)",
		"result": "2.506628275"
	},
	{
		"name": "STANDARDIZE",
		"category": "Statistical",
		"syntax": "STANDARDIZE(x, mean, standard_dev)",
		"description": "Returns how many standard deviations a value is from the mean (z-score).",
		"example": "=STANDARDIZE(42, 40, 1.5)",
		"result": "1.333333333"
	},
	{
		"name": "STDEV",
		"category": "Compatibility",
		"syntax": "STDEV(number1, [number2], …)",
		"description": "Older name for STDEV.S. Returns the standard deviation of a sample.",
		"example": "=STDEV(2, 4, 4, 4, 5, 5, 7, 9)",
		"result": "2.138089935"
	},
	{
		"name": "STDEV.P",
		"category": "Statistical",
		"syntax": "STDEV.P(number1, [number2], …)",
		"description": "Returns the standard deviation of a whole population.",
		"example": "=STDEV.P(2, 4, 4, 4, 5, 5, 7, 9)",
		"result": "2"
	},
	{
		"name": "STDEV.S",
		"category": "Statistical",
		"syntax": "STDEV.S(number1, [number2], …)",
		"description": "Returns the standard deviation of a sample.",
		"example": "=STDEV.S(2, 4, 4, 4, 5, 5, 7, 9)",
		"result": "2.138089935"
	},
	{
		"name": "STDEVA",
		"category": "Statistical",
		"syntax": "STDEVA(value1, [value2], …)",
		"description": "Returns a sample standard deviation, counting TRUE as 1 and text or FALSE as 0.",
		"example": "=STDEVA(2, 4, TRUE)",
		"result": "1.527525232"
	},
	{
		"name": "STDEVP",
		"category": "Compatibility",
		"syntax": "STDEVP(number1, [number2], …)",
		"description": "Older name for STDEV.P. Returns the standard deviation of a whole population.",
		"example": "=STDEVP(2, 4, 4, 4, 5, 5, 7, 9)",
		"result": "2"
	},
	{
		"name": "STDEVPA",
		"category": "Statistical",
		"syntax": "STDEVPA(value1, [value2], …)",
		"description": "Returns a population standard deviation, counting TRUE as 1 and text or FALSE as 0.",
		"example": "=STDEVPA(2, 4, TRUE)",
		"result": "1.247219129"
	},
	{
		"name": "STEYX",
		"category": "Statistical",
		"syntax": "STEYX(known_ys, known_xs)",
		"description": "Returns the standard error of predicted y-values in a straight-line fit.",
		"example": "=STEYX({2, 3, 9, 1, 8}, {6, 5, 11, 7, 5})",
		"result": "3.745606746"
	},
	{
		"name": "SUBSTITUTE",
		"category": "Text",
		"syntax": "SUBSTITUTE(text, old_text, new_text, [instance_num])",
		"description": "Replaces occurrences of some text with new text.",
		"example": "=SUBSTITUTE(\"2026-03-14\", \"-\", \"/\")",
		"result": "2026/03/14"
	},
	{
		"name": "SUBTOTAL",
		"category": "Math & trig",
		"syntax": "SUBTOTAL(function_num, ref1, [ref2], …)",
		"description": "Returns a subtotal of a list, such as a sum (9) or an average (1).",
		"example": "=SUBTOTAL(9, {10, 20, 30})",
		"result": "60"
	},
	{
		"name": "SUM",
		"category": "Math & trig",
		"syntax": "SUM(number1, [number2], …)",
		"description": "Adds numbers, cell values and ranges.",
		"example": "=SUM(10, 20, 30)",
		"sheetExample": "=SUM([Amount]:[Amount])",
		"result": "60"
	},
	{
		"name": "SUMIF",
		"category": "Math & trig",
		"syntax": "SUMIF(range, criteria, [sum_range])",
		"description": "Adds the values that meet one condition.",
		"example": "=SUMIF({1, 5, 10}, \">4\")",
		"sheetExample": "=SUMIF([Status]:[Status], \"Unpaid\", [Amount]:[Amount])",
		"result": "15"
	},
	{
		"name": "SUMIFS",
		"category": "Math & trig",
		"syntax": "SUMIFS(sum_range, criteria_range1, criteria1, …)",
		"description": "Adds the values that meet every one of several conditions.",
		"example": "=SUMIFS({10, 20, 30}, {\"a\", \"b\", \"a\"}, \"a\", {1, 2, 3}, \">1\")",
		"sheetExample": "=SUMIFS([Amount]:[Amount], [Status]:[Status], \"Unpaid\", [Supplier]:[Supplier], \"Acme Ltd\")",
		"result": "30"
	},
	{
		"name": "SUMPRODUCT",
		"category": "Math & trig",
		"syntax": "SUMPRODUCT(array1, [array2], …)",
		"description": "Multiplies matching items in arrays and adds up the results.",
		"example": "=SUMPRODUCT({2, 3}, {10, 20})",
		"result": "80"
	},
	{
		"name": "SUMSQ",
		"category": "Math & trig",
		"syntax": "SUMSQ(number1, [number2], …)",
		"description": "Returns the sum of the squares of its arguments.",
		"example": "=SUMSQ(3, 4)",
		"result": "25"
	},
	{
		"name": "SUMX2MY2",
		"category": "Math & trig",
		"syntax": "SUMX2MY2(array_x, array_y)",
		"description": "Returns the sum of the differences of the squares of matching values.",
		"example": "=SUMX2MY2({2, 3}, {1, 2})",
		"result": "8"
	},
	{
		"name": "SUMX2PY2",
		"category": "Math & trig",
		"syntax": "SUMX2PY2(array_x, array_y)",
		"description": "Returns the sum of the sums of the squares of matching values.",
		"example": "=SUMX2PY2({2, 3}, {1, 2})",
		"result": "18"
	},
	{
		"name": "SUMXMY2",
		"category": "Math & trig",
		"syntax": "SUMXMY2(array_x, array_y)",
		"description": "Returns the sum of the squares of the differences of matching values.",
		"example": "=SUMXMY2({2, 3}, {1, 2})",
		"result": "2"
	},
	{
		"name": "SWITCH",
		"category": "Logical",
		"syntax": "SWITCH(expression, value1, result1, [value2, result2], …, [default])",
		"description": "Compares a value with a list and returns the result for the first match, or a default.",
		"example": "=SWITCH(2, 1, \"Low\", 2, \"Medium\", 3, \"High\", \"Unknown\")",
		"result": "Medium"
	},
	{
		"name": "SYD",
		"category": "Financial",
		"syntax": "SYD(cost, salvage, life, per)",
		"description": "Returns sum-of-years' digits depreciation for a period.",
		"example": "=SYD(30000, 7500, 10, 1)",
		"result": "4090.909091"
	},
	{
		"name": "T",
		"category": "Text",
		"syntax": "T(value)",
		"description": "Returns the value if it is text, and empty text otherwise.",
		"example": "=T(\"Paid\")",
		"result": "Paid"
	},
	{
		"name": "T.DIST",
		"category": "Statistical",
		"syntax": "T.DIST(x, deg_freedom, cumulative)",
		"description": "Returns the left-tailed Student's t distribution.",
		"example": "=T.DIST(1.96, 30, TRUE)",
		"result": "0.9703288436"
	},
	{
		"name": "T.DIST.2T",
		"category": "Statistical",
		"syntax": "T.DIST.2T(x, deg_freedom)",
		"description": "Returns the two-tailed Student's t distribution.",
		"example": "=T.DIST.2T(1.96, 30)",
		"result": "0.0593423129"
	},
	{
		"name": "T.DIST.RT",
		"category": "Statistical",
		"syntax": "T.DIST.RT(x, deg_freedom)",
		"description": "Returns the right-tailed Student's t distribution.",
		"example": "=T.DIST.RT(1.96, 30)",
		"result": "0.02967115645"
	},
	{
		"name": "T.INV",
		"category": "Statistical",
		"syntax": "T.INV(probability, deg_freedom)",
		"description": "Returns the left-tailed inverse of the Student's t distribution.",
		"example": "=T.INV(0.975, 30)",
		"result": "2.042272456"
	},
	{
		"name": "T.INV.2T",
		"category": "Statistical",
		"syntax": "T.INV.2T(probability, deg_freedom)",
		"description": "Returns the two-tailed inverse of the Student's t distribution.",
		"example": "=T.INV.2T(0.05, 30)",
		"result": "2.042272456"
	},
	{
		"name": "T.TEST",
		"category": "Statistical",
		"syntax": "T.TEST(array1, array2, tails, type)",
		"description": "Returns the probability from a Student's t-test comparing two sets of values.",
		"example": "=T.TEST({3, 4, 5, 8, 9}, {6, 19, 3, 2, 14}, 2, 1)",
		"result": "0.4472750444"
	},
	{
		"name": "TAKE",
		"category": "Lookup & reference",
		"syntax": "TAKE(array, rows, [columns])",
		"description": "Returns rows or columns from the start (positive) or end (negative) of an array.",
		"example": "=TAKE({1; 2; 3; 4}, -2)",
		"note": "Returns several values; a cell shows the first one.",
		"result": "3"
	},
	{
		"name": "TAN",
		"category": "Math & trig",
		"syntax": "TAN(number)",
		"description": "Returns the tangent of an angle given in radians.",
		"example": "=TAN(PI() / 4)",
		"result": "1"
	},
	{
		"name": "TANH",
		"category": "Math & trig",
		"syntax": "TANH(number)",
		"description": "Returns the hyperbolic tangent of a number.",
		"example": "=TANH(1)",
		"result": "0.761594156"
	},
	{
		"name": "TBILLEQ",
		"category": "Financial",
		"syntax": "TBILLEQ(settlement, maturity, discount)",
		"description": "Returns the bond-equivalent yield of a Treasury bill.",
		"example": "=TBILLEQ(DATE(2026, 3, 31), DATE(2026, 6, 1), 0.0914)",
		"result": "0.09415149357"
	},
	{
		"name": "TBILLPRICE",
		"category": "Financial",
		"syntax": "TBILLPRICE(settlement, maturity, discount)",
		"description": "Returns the price per 100 of face value of a Treasury bill.",
		"example": "=TBILLPRICE(DATE(2026, 3, 31), DATE(2026, 6, 1), 0.09)",
		"result": "98.45"
	},
	{
		"name": "TBILLYIELD",
		"category": "Financial",
		"syntax": "TBILLYIELD(settlement, maturity, pr)",
		"description": "Returns the yield of a Treasury bill.",
		"example": "=TBILLYIELD(DATE(2026, 3, 31), DATE(2026, 6, 1), 98.45)",
		"result": "0.09141696293"
	},
	{
		"name": "TEXT",
		"category": "Text",
		"syntax": "TEXT(value, format_text)",
		"description": "Formats a number or date as text using a format code.",
		"example": "=TEXT(1234.5, \"#,##0.00\")",
		"note": "Number codes such as \"#,##0.00\" work; decimal percentages, currency symbols and month names in the format code aren't applied yet.",
		"result": "1,234.50"
	},
	{
		"name": "TEXTAFTER",
		"category": "Text",
		"syntax": "TEXTAFTER(text, delimiter, [instance_num], [match_mode], [match_end], [if_not_found])",
		"description": "Returns the text that comes after a delimiter.",
		"example": "=TEXTAFTER(\"name@example.com\", \"@\")",
		"result": "example.com"
	},
	{
		"name": "TEXTBEFORE",
		"category": "Text",
		"syntax": "TEXTBEFORE(text, delimiter, [instance_num], [match_mode], [match_end], [if_not_found])",
		"description": "Returns the text that comes before a delimiter.",
		"example": "=TEXTBEFORE(\"name@example.com\", \"@\")",
		"result": "name"
	},
	{
		"name": "TEXTJOIN",
		"category": "Text",
		"syntax": "TEXTJOIN(delimiter, ignore_empty, text1, [text2], …)",
		"description": "Joins text with a delimiter between each item, optionally skipping empty values.",
		"example": "=TEXTJOIN(\", \", TRUE, \"Travel\", \"\", \"Meals\")",
		"result": "Travel, Meals"
	},
	{
		"name": "TEXTSPLIT",
		"category": "Text",
		"syntax": "TEXTSPLIT(text, col_delimiter, [row_delimiter], [ignore_empty], [match_mode], [pad_with])",
		"description": "Splits text into an array at each delimiter.",
		"example": "=TEXTSPLIT(\"red,green,blue\", \",\")",
		"note": "Returns several values; a cell shows the first one.",
		"result": "red"
	},
	{
		"name": "TIME",
		"category": "Date & time",
		"syntax": "TIME(hour, minute, second)",
		"description": "Returns a time from hour, minute and second numbers.",
		"example": "=TIME(9, 45, 0)",
		"result": "09:45:00"
	},
	{
		"name": "TIMEVALUE",
		"category": "Date & time",
		"syntax": "TIMEVALUE(time_text)",
		"description": "Converts a time written as text into a time value (a fraction of a day).",
		"example": "=TIMEVALUE(\"6:30 PM\")",
		"result": "18:30:00"
	},
	{
		"name": "TINV",
		"category": "Compatibility",
		"syntax": "TINV(probability, deg_freedom)",
		"description": "Older name for T.INV.2T. Returns the two-tailed inverse of the Student's t distribution.",
		"example": "=TINV(0.05, 30)",
		"result": "2.042272456"
	},
	{
		"name": "TOCOL",
		"category": "Lookup & reference",
		"syntax": "TOCOL(array, [ignore], [scan_by_column])",
		"description": "Returns all values of an array as a single column.",
		"example": "=TOCOL({1, 2; 3, 4})",
		"note": "Returns several values; a cell shows the first one.",
		"result": "1"
	},
	{
		"name": "TODAY",
		"category": "Date & time",
		"syntax": "TODAY()",
		"description": "Returns today's date.",
		"example": "=TODAY()",
		"note": "Changes each time the sheet recalculates."
	},
	{
		"name": "TOROW",
		"category": "Lookup & reference",
		"syntax": "TOROW(array, [ignore], [scan_by_column])",
		"description": "Returns all values of an array as a single row.",
		"example": "=TOROW({1, 2; 3, 4})",
		"note": "Returns several values; a cell shows the first one.",
		"result": "1"
	},
	{
		"name": "TRANSPOSE",
		"category": "Lookup & reference",
		"syntax": "TRANSPOSE(array)",
		"description": "Flips an array so rows become columns.",
		"example": "=TRANSPOSE({1, 2, 3})",
		"note": "Returns several values; a cell shows the first one.",
		"result": "1"
	},
	{
		"name": "TREND",
		"category": "Statistical",
		"syntax": "TREND(known_ys, [known_xs], [new_xs], [const])",
		"description": "Predicts values along a straight-line trend.",
		"example": "=TREND({10, 20, 30}, {1, 2, 3}, 4)",
		"result": "40"
	},
	{
		"name": "TRIM",
		"category": "Text",
		"syntax": "TRIM(text)",
		"description": "Removes spaces from the start and end of text and collapses repeated spaces between words.",
		"example": "=TRIM(\"  zenith   logistics \")",
		"sheetExample": "=TRIM([Supplier]@row)",
		"result": "zenith logistics"
	},
	{
		"name": "TRIMMEAN",
		"category": "Statistical",
		"syntax": "TRIMMEAN(array, percent)",
		"description": "Returns the mean after leaving out a percentage of the highest and lowest values.",
		"example": "=TRIMMEAN({4, 5, 6, 7, 2, 3, 4, 5, 1, 2, 3}, 0.2)",
		"result": "3.777777778"
	},
	{
		"name": "TRUE",
		"category": "Logical",
		"syntax": "TRUE()",
		"description": "Returns the logical value TRUE.",
		"example": "=TRUE()",
		"result": "TRUE"
	},
	{
		"name": "TRUNC",
		"category": "Math & trig",
		"syntax": "TRUNC(number, [num_digits])",
		"description": "Cuts off a number's decimals without rounding.",
		"example": "=TRUNC(8.97, 1)",
		"result": "8.9"
	},
	{
		"name": "TTEST",
		"category": "Compatibility",
		"syntax": "TTEST(array1, array2, tails, type)",
		"description": "Older name for T.TEST. Returns the probability from a Student's t-test comparing two sets of values.",
		"example": "=TTEST({3, 4, 5, 8, 9}, {6, 19, 3, 2, 14}, 2, 1)",
		"result": "0.4472750444"
	},
	{
		"name": "TYPE",
		"category": "Information",
		"syntax": "TYPE(value)",
		"description": "Returns the type of a value as a number: 1 number, 2 text, 4 logical, 16 error, 64 array.",
		"example": "=TYPE(\"Paid\")",
		"result": "2"
	},
	{
		"name": "UNICHAR",
		"category": "Text",
		"syntax": "UNICHAR(number)",
		"description": "Returns the Unicode character for a number.",
		"example": "=UNICHAR(8364)",
		"result": "€"
	},
	{
		"name": "UNICODE",
		"category": "Text",
		"syntax": "UNICODE(text)",
		"description": "Returns the Unicode number of the first character in text.",
		"example": "=UNICODE(\"€\")",
		"result": "8364"
	},
	{
		"name": "UNIQUE",
		"category": "Lookup & reference",
		"syntax": "UNIQUE(array, [by_col], [exactly_once])",
		"description": "Returns the distinct values of an array.",
		"example": "=UNIQUE({\"Paid\"; \"Unpaid\"; \"Paid\"})",
		"note": "Returns several values; a cell shows the first one.",
		"result": "Paid"
	},
	{
		"name": "UPPER",
		"category": "Text",
		"syntax": "UPPER(text)",
		"description": "Converts text to uppercase.",
		"example": "=UPPER(\"unpaid\")",
		"result": "UNPAID"
	},
	{
		"name": "VALUE",
		"category": "Text",
		"syntax": "VALUE(text)",
		"description": "Converts text that looks like a number into a number.",
		"example": "=VALUE(\"1480.5\")",
		"result": "1480.5"
	},
	{
		"name": "VALUETOTEXT",
		"category": "Text",
		"syntax": "VALUETOTEXT(value, [format])",
		"description": "Returns any value as text.",
		"example": "=VALUETOTEXT(123.5)",
		"result": "123.5"
	},
	{
		"name": "VAR",
		"category": "Compatibility",
		"syntax": "VAR(number1, [number2], …)",
		"description": "Older name for VAR.S. Returns the variance of a sample.",
		"example": "=VAR(2, 4, 4, 4, 5, 5, 7, 9)",
		"result": "4.571428571"
	},
	{
		"name": "VAR.P",
		"category": "Statistical",
		"syntax": "VAR.P(number1, [number2], …)",
		"description": "Returns the variance of a whole population.",
		"example": "=VAR.P(2, 4, 4, 4, 5, 5, 7, 9)",
		"result": "4"
	},
	{
		"name": "VAR.S",
		"category": "Statistical",
		"syntax": "VAR.S(number1, [number2], …)",
		"description": "Returns the variance of a sample.",
		"example": "=VAR.S(2, 4, 4, 4, 5, 5, 7, 9)",
		"result": "4.571428571"
	},
	{
		"name": "VARA",
		"category": "Statistical",
		"syntax": "VARA(value1, [value2], …)",
		"description": "Returns a sample variance, counting TRUE as 1 and text or FALSE as 0.",
		"example": "=VARA(2, 4, TRUE)",
		"result": "2.333333333"
	},
	{
		"name": "VARP",
		"category": "Compatibility",
		"syntax": "VARP(number1, [number2], …)",
		"description": "Older name for VAR.P. Returns the variance of a whole population.",
		"example": "=VARP(2, 4, 4, 4, 5, 5, 7, 9)",
		"result": "4"
	},
	{
		"name": "VARPA",
		"category": "Statistical",
		"syntax": "VARPA(value1, [value2], …)",
		"description": "Returns a population variance, counting TRUE as 1 and text or FALSE as 0.",
		"example": "=VARPA(2, 4, TRUE)",
		"result": "1.555555556"
	},
	{
		"name": "VLOOKUP",
		"category": "Lookup & reference",
		"syntax": "VLOOKUP(lookup_value, table_array, col_index_num, [range_lookup])",
		"description": "Looks for a value in the first column of a table and returns the value from another column in that row. Use FALSE for an exact match.",
		"example": "=VLOOKUP(\"KT-5510\", {\"AC-1042\", 1250; \"KT-5510\", 3200}, 2, FALSE)",
		"result": "3200"
	},
	{
		"name": "VSTACK",
		"category": "Lookup & reference",
		"syntax": "VSTACK(array1, [array2], …)",
		"description": "Stacks arrays on top of each other into one array.",
		"example": "=VSTACK({1, 2}, {3, 4})",
		"note": "Returns several values; a cell shows the first one.",
		"result": "1"
	},
	{
		"name": "WEEKDAY",
		"category": "Date & time",
		"syntax": "WEEKDAY(date, [return_type])",
		"description": "Returns the day of the week as a number; by default 1 is Sunday and 7 is Saturday.",
		"example": "=WEEKDAY(DATE(2026, 3, 14))",
		"result": "7"
	},
	{
		"name": "WEEKNUM",
		"category": "Date & time",
		"syntax": "WEEKNUM(date, [return_type])",
		"description": "Returns the week number of the year for a date.",
		"example": "=WEEKNUM(DATE(2026, 3, 14))",
		"result": "11"
	},
	{
		"name": "WEIBULL.DIST",
		"category": "Statistical",
		"syntax": "WEIBULL.DIST(x, alpha, beta, cumulative)",
		"description": "Returns the Weibull distribution.",
		"example": "=WEIBULL.DIST(105, 20, 100, TRUE)",
		"result": "0.9295813901"
	},
	{
		"name": "WORKDAY",
		"category": "Date & time",
		"syntax": "WORKDAY(start_date, days, [holidays])",
		"description": "Returns the date a number of working days before or after a date.",
		"example": "=WORKDAY(DATE(2026, 9, 15), 10)",
		"result": "46294 (2026-09-29)",
		"note": "Returns the date as a serial day number."
	},
	{
		"name": "WORKDAY.INTL",
		"category": "Date & time",
		"syntax": "WORKDAY.INTL(start_date, days, [weekend], [holidays])",
		"description": "Returns the date a number of working days away, with the weekend you choose.",
		"example": "=WORKDAY.INTL(DATE(2026, 9, 15), 10, 7)",
		"result": "46294 (2026-09-29)",
		"note": "Returns the date as a serial day number."
	},
	{
		"name": "XIRR",
		"category": "Financial",
		"syntax": "XIRR(values, dates, [guess])",
		"description": "Returns the internal rate of return for cash flows on specific dates.",
		"example": "=XIRR({-10000, 2750, 4250, 3250, 2750}, {46023, 46082, 46325, 46433, 46478})",
		"result": "0.3748585977"
	},
	{
		"name": "XLOOKUP",
		"category": "Lookup & reference",
		"syntax": "XLOOKUP(lookup_value, lookup_array, return_array, [if_not_found], [match_mode], [search_mode])",
		"description": "Finds a value in one range and returns the item in the same position of another range.",
		"example": "=XLOOKUP(\"Feb\", {\"Jan\", \"Feb\", \"Mar\"}, {100, 120, 90}, \"Not found\")",
		"sheetExample": "=XLOOKUP(\"Acme Ltd\", [Supplier]:[Supplier], [Amount]:[Amount], 0)",
		"result": "120"
	},
	{
		"name": "XMATCH",
		"category": "Lookup & reference",
		"syntax": "XMATCH(lookup_value, lookup_array, [match_mode], [search_mode])",
		"description": "Returns the position of an item in an array or range.",
		"example": "=XMATCH(90, {100, 120, 90})",
		"result": "3"
	},
	{
		"name": "XNPV",
		"category": "Financial",
		"syntax": "XNPV(rate, values, dates)",
		"description": "Returns the net present value of cash flows on specific dates.",
		"example": "=XNPV(0.09, {-10000, 2750, 4250, 3250, 2750}, {46023, 46082, 46325, 46433, 46478})",
		"result": "2089.501636"
	},
	{
		"name": "XOR",
		"category": "Logical",
		"syntax": "XOR(logical1, [logical2], …)",
		"description": "Returns TRUE if an odd number of its arguments are TRUE.",
		"example": "=XOR(TRUE, FALSE)",
		"result": "TRUE"
	},
	{
		"name": "YEAR",
		"category": "Date & time",
		"syntax": "YEAR(date)",
		"description": "Returns the year of a date.",
		"example": "=YEAR(DATE(2026, 3, 14))",
		"result": "2026"
	},
	{
		"name": "YEARFRAC",
		"category": "Date & time",
		"syntax": "YEARFRAC(start_date, end_date, [basis])",
		"description": "Returns the fraction of a year between two dates.",
		"example": "=YEARFRAC(DATE(2026, 1, 1), DATE(2026, 7, 1))",
		"result": "0.5"
	},
	{
		"name": "YIELD",
		"category": "Financial",
		"syntax": "YIELD(settlement, maturity, rate, pr, redemption, frequency, [basis])",
		"description": "Returns the yield of a security that pays interest periodically.",
		"example": "=YIELD(DATE(2026, 2, 15), DATE(2034, 11, 15), 0.0575, 95.04287, 100, 2)",
		"result": "0.06500000688"
	},
	{
		"name": "Z.TEST",
		"category": "Statistical",
		"syntax": "Z.TEST(array, x, [sigma])",
		"description": "Returns the one-tailed probability from a z-test.",
		"example": "=Z.TEST({3, 6, 7, 8, 6, 5, 4, 2, 1, 9}, 4)",
		"note": "When sigma is left out, this engine uses the population standard deviation, so the result can differ slightly from Excel. Pass sigma to be exact.",
		"result": "0.0793345963"
	},
	{
		"name": "ZTEST",
		"category": "Compatibility",
		"syntax": "ZTEST(array, x, [sigma])",
		"description": "Older name for Z.TEST. Returns the one-tailed probability from a z-test.",
		"example": "=ZTEST({3, 6, 7, 8, 6, 5, 4, 2, 1, 9}, 4)",
		"result": "0.0793345963"
	}
];
