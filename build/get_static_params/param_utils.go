package main

import (
	"database/sql"
	"fmt"
	"regexp"
	"slices"
	"strings"
	"time"
	"unicode"

	_ "github.com/go-sql-driver/mysql"
)

// Companies come from the followed models of the Swedish XBRL user accounts
// (Denmark used XBRLDenmark / XBRLDenmarkIFRS). Same columns as the Danish
// tool; the last one (S.ISIN) holds the company code, i.e. the orgnr.
func sqlFor(accounts []string, updatedSince *int64) string {
	quoted := make([]string, len(accounts))
	for i, a := range accounts {
		quoted[i] = "'" + strings.ReplaceAll(a, "'", "") + "'"
	}
	q := fmt.Sprintf(`
select F.FOLLOWEDMODELID, C.NAME, I.NACE, S.ISIN from FOLLOWEDMODEL F
join COMPANY C on F.COMPANYID = C.COMPANYID
join INDUSTRY I on C.INDUSTRYID = I.INDUSTRYID
join STOCKRATE S on S.STOCKRATEID = C.TICKERAID
where F.USERACCOUNTID in (select USERACCOUNTID from USERACCOUNT where NICKNAME in (%s))`, strings.Join(quoted, ","))
	if updatedSince != nil {
		q += fmt.Sprintf("\n and F.VERSION > %d", *updatedSince)
	}
	return q + "\norder by I.NACE"
}

// Convert a company name into an URL-friendly version.
func slugify(name string) string {
	// Normalize unicode to ASCII
	var b strings.Builder
	for _, r := range name {
		if r > unicode.MaxASCII {
			continue
		}
		b.WriteRune(r)
	}
	s := strings.ToLower(b.String())
	s = regexp.MustCompile(`[\s_]+`).ReplaceAllString(s, "-")
	s = regexp.MustCompile(`[^a-z0-9-]`).ReplaceAllString(s, "")
	s = regexp.MustCompile(`-+`).ReplaceAllString(s, "-")
	s = strings.Trim(s, "-")
	return s
}

func getAllStaticParams(conn *sql.DB, accounts []string, fids []string) ([]string, []string, error) {
	rows, err := conn.Query(sqlFor(accounts, nil))
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()

	paramsAll := make([]string, 0)
	paramsBatch := make([]string, 0)

	for rows.Next() {
		var fid, name, nace, isin string
		if err := rows.Scan(&fid, &name, &nace, &isin); err != nil {
			return nil, nil, err
		}
		row := fmt.Sprintf("%s\t%s\t%s\t%s\t%s\n", fid, slugify(name), name, nace, isin)
		paramsAll = append(paramsAll, row)
		if len(fids) > 0 && slices.Contains(fids, fid) {
			paramsBatch = append(paramsBatch, row)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	return paramsAll, paramsBatch, nil
}

func getUpdatedStaticParams(conn *sql.DB, accounts []string, includeUpdatedSince int64) ([]string, error) {
	fmt.Println("Getting updated static params since", includeUpdatedSince)
	fmt.Println("-> In other words, since ", time.Unix(includeUpdatedSince/1000, 0))

	rows, err := conn.Query(sqlFor(accounts, &includeUpdatedSince))
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	params := make([]string, 0)
	for rows.Next() {
		var fid, name, nace, isin string
		if err := rows.Scan(&fid, &name, &nace, &isin); err != nil {
			return nil, err
		}
		params = append(params, fmt.Sprintf("%s\t%s\t%s\t%s\t%s\n", fid, slugify(name), name, nace, isin))
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return params, nil
}

func mergeParams(params []string, paramsBatch []string) []string {
	paramsMap := make(map[string]string)
	for _, param := range params {
		paramsMap[param] = param
	}
	for _, param := range paramsBatch {
		paramsMap[param] = param
	}
	ret := make([]string, 0, len(paramsMap))
	for _, param := range paramsMap {
		ret = append(ret, param)
	}
	return ret
}
