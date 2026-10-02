package main

import (
	"bufio"
	"context"
	"os"
	"strings"
)

func readJavaPropertiesFile(filename string) (map[string]string, error) {
	props := make(map[string]string)
	file, err := os.Open(filename)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		parts := strings.SplitN(line, "=", 2)
		if len(parts) != 2 {
			continue
		}
		key := strings.TrimSpace(parts[0])
		value := strings.TrimSpace(parts[1])
		props[key] = value
	}
	return props, scanner.Err()
}

func getAllProperties(files []string) (map[string]string, error) {
	props := make(map[string]string)
	ctx := context.Background()
	var tempFiles []string
	for _, file := range files {
		realFile := file
		if isS3URI(file) {
			tmp, err := downloadS3File(ctx, file)
			if err != nil {
				return nil, err
			}
			realFile = tmp
			tempFiles = append(tempFiles, tmp)
		}
		p, err := readJavaPropertiesFile(realFile)
		if err != nil {
			return nil, err
		}
		for k, v := range p {
			props[k] = v
		}
	}
	// Clean up temp files after use
	for _, f := range tempFiles {
		os.Remove(f)
	}
	return props, nil
}
