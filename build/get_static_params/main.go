package main

import (
	"database/sql"
	"flag"
	"fmt"
	"os"
	"strconv"
	"strings"

	_ "github.com/go-sql-driver/mysql"
)

func getDBConnection(props map[string]string) (*sql.DB, error) {
	host := props["database.server"]
	user := props["database.userid"]
	pass := props["database.password"]
	db := props["database.sid"]
	dsn := fmt.Sprintf("%s:%s@tcp(%s)/%s?charset=utf8mb4&parseTime=true", user, pass, host, db)
	return sql.Open("mysql", dsn)
}

func usage() {
	example := "Example: ./get_static_params --output-dir out " +
		"--properties s3://valu-produ/<swedish-backend>/config/local_server.properties --fids 123 234 " +
		"--include-updated-since $(($(date -d \"24 hours ago\" +%s) * 1000))"
	fmt.Println("Usage: --output-dir <dir> --properties <file> [--accounts <nicknames>] " +
		"[--fids <fids>] [--include-updated-since <timestamp>]")
	fmt.Println()
	fmt.Println(example)
	fmt.Println()
	fmt.Println("This program is used to generate the 'staticparams.txt' and 'staticparams_batch.txt' files.")
	fmt.Println("They are used as parameters for the pages that need to be built. The files contain rows with the following fields:")
	fmt.Println("")
	fmt.Println("\tfid: followedModelId\n\tslug: URL-friendly version of the company name\n" +
		"\tname: company name\n\tnace: SNI code\n\tisin: company code (orgnr)")
	fmt.Println("")
	fmt.Println("The fields are separated by tabs.")
	fmt.Println("")
}

func parseArgs() (string, []string, []string, []string, *int64) {
	outputDir := flag.String("output-dir", "",
		"Output directory for 'staticparams.txt' that contains all fids.")
	properties := flag.String("properties", "",
		"Java properties file with DB credentials (local or s3://bucket/key)")
	fids := flag.String("fids", "",
		"Optional. Get another output file with only these fids as 'staticparams_batch.txt'. "+
			"They must be fids that will also exist in the 'staticparams.txt' file.")
	includeUpdatedSince := flag.String("include-updated-since", "",
		"Optional. Unix timestamp in milliseconds. Get fids that have been updated since the given"+
			"timestamp. These will be included in the 'staticparams_batch.txt' file.")
	accounts := flag.String("accounts", "Bolagsverket data import",
		"Comma-separated USERACCOUNT nicknames whose followed models are the Swedish companies "+
			"(nicknames contain spaces, e.g. the Bolagsverket import user 'Bolagsverket data import').")
	flag.Parse()

	if *outputDir == "" || *properties == "" {
		usage()
		os.Exit(1)
	}

	var includeUpdatedSinceRet *int64
	if *includeUpdatedSince != "" {
		includeUpdatedSinceInt, err := strconv.ParseInt(*includeUpdatedSince, 10, 64)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error parsing include-updated-since: %v\n", err)
			os.Exit(1)
		}
		includeUpdatedSinceRet = &includeUpdatedSinceInt
	}

	return *outputDir, strings.Fields(*properties), strings.Fields(*fids),
		splitList(*accounts, ","), includeUpdatedSinceRet
}

func writeFile(path string, data []string) error {
	out, err := os.Create(path)
	if err != nil {
		return err
	}
	defer out.Close()
	for _, line := range data {
		if _, err := out.WriteString(line); err != nil {
			return err
		}
	}
	return nil
}

func main() {
	outputDir, properties, fids, accounts, includeUpdatedSince := parseArgs()

	props, err := getAllProperties(properties)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error reading properties: %v\n", err)
		os.Exit(1)
	}
	conn, err := getDBConnection(props)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error connecting to DB: %v\n", err)
		os.Exit(1)
	}
	defer conn.Close()

	paramsAll, paramsBatch, err := getAllStaticParams(conn, accounts, fids)

	if err != nil {
		fmt.Fprintf(os.Stderr, "Error getting static params: %v\n", err)
		os.Exit(1)
	}
	if includeUpdatedSince != nil {
		paramsUpdated, err := getUpdatedStaticParams(conn, accounts, *includeUpdatedSince)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error getting updated static params: %v\n", err)
			os.Exit(1)
		}
		paramsBatch = mergeParams(paramsBatch, paramsUpdated)
	}
	if err := writeFile(outputDir+"/staticparams.txt", paramsAll); err != nil {
		fmt.Fprintf(os.Stderr, "Error writing staticparams.txt: %v\n", err)
		os.Exit(1)
	} else {
		fmt.Println("wrote " + outputDir + "/staticparams.txt")
	}
	if len(paramsBatch) > 0 {
		if err := writeFile(outputDir+"/staticparams_batch.txt", paramsBatch); err != nil {
			fmt.Fprintf(os.Stderr, "Error writing staticparams_batch.txt: %v\n", err)
			os.Exit(1)
		}
		fmt.Println("wrote " + outputDir + "/staticparams_batch.txt")
	} else {
		fmt.Println("No staticparams_batch.txt file was created.")
	}
	fmt.Println("Done.")
}

// splitList splits on sep and drops empty, space-only items.
func splitList(s, sep string) []string {
	var out []string
	for _, item := range strings.Split(s, sep) {
		if item = strings.TrimSpace(item); item != "" {
			out = append(out, item)
		}
	}
	return out
}
