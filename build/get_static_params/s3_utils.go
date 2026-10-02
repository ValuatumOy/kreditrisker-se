package main

import (
	"context"
	"fmt"
	"io"
	"os"
	"strings"

	_ "github.com/go-sql-driver/mysql"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

func isS3URI(path string) bool {
	return strings.HasPrefix(path, "s3://")
}

func downloadS3File(ctx context.Context, s3uri string) (string, error) {
	// Parse s3://bucket/key
	trimmed := strings.TrimPrefix(s3uri, "s3://")
	parts := strings.SplitN(trimmed, "/", 2)
	if len(parts) != 2 {
		return "", fmt.Errorf("invalid S3 URI: %s", s3uri)
	}
	bucket, key := parts[0], parts[1]

	cfg, err := config.LoadDefaultConfig(ctx)
	if err != nil {
		return "", fmt.Errorf("unable to load AWS config: %w", err)
	}
	client := s3.NewFromConfig(cfg)

	getObjInput := &s3.GetObjectInput{
		Bucket: aws.String(bucket),
		Key:    aws.String(key),
	}
	resp, err := client.GetObject(ctx, getObjInput)
	if err != nil {
		return "", fmt.Errorf("failed to get S3 object: %w", err)
	}
	defer resp.Body.Close()

	tmpFile, err := os.CreateTemp("", "get-static-params-s3-dl-*.properties")
	if err != nil {
		return "", fmt.Errorf("failed to create temp file: %w", err)
	}
	defer tmpFile.Close()

	_, err = io.Copy(tmpFile, resp.Body)
	if err != nil {
		return "", fmt.Errorf("failed to copy S3 object to temp file: %w", err)
	}
	return tmpFile.Name(), nil
}
