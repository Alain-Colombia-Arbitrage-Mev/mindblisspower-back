package main

import (
	"go/ast"
	"go/parser"
	"go/token"
	"testing"
)

// Configuration tests cover values; this structural regression ensures startup
// cannot launch the evaluator or a provider loop outside the read-only boundary.
func TestReadOnlyStartupGuardsAllJobsAndStripe(t *testing.T) {
	f, err := parser.ParseFile(token.NewFileSet(), "main.go", nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	var jobs, providers, nowJobs []*ast.BlockStmt
	wrapped := false
	ast.Inspect(f, func(n ast.Node) bool {
		if statement, ok := n.(*ast.IfStmt); ok {
			if enabled, ok := statement.Cond.(*ast.SelectorExpr); ok && enabled.Sel.Name == "Enabled" {
				if feature, ok := enabled.X.(*ast.SelectorExpr); ok && feature.Sel.Name == "NOWPaymentsOperational" {
					nowJobs = append(nowJobs, statement.Body)
				}
			}
			ast.Inspect(statement.Cond, func(n ast.Node) bool {
				call, ok := n.(*ast.CallExpr)
				if !ok {
					return true
				}
				if selector, ok := call.Fun.(*ast.SelectorExpr); ok {
					switch selector.Sel.Name {
					case "BackgroundJobsEnabled":
						jobs = append(jobs, statement.Body)
					case "ExternalProvidersEnabled":
						providers = append(providers, statement.Body)
					}
				}
				return true
			})
		}
		if call, ok := n.(*ast.CallExpr); ok {
			if selector, ok := call.Fun.(*ast.SelectorExpr); ok && selector.Sel.Name == "ReadOnlyHandler" {
				wrapped = true
			}
		}
		return true
	})
	if len(jobs) != 1 || len(nowJobs) != 1 || !wrapped {
		t.Fatal("all jobs need one explicit boundary and the router must be wrapped")
	}
	inside := func(pos token.Pos, blocks []*ast.BlockStmt) bool {
		for _, block := range blocks {
			if pos > block.Pos() && pos < block.End() {
				return true
			}
		}
		return false
	}
	count := 0
	ast.Inspect(f, func(n ast.Node) bool {
		call, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}
		selector, ok := call.Fun.(*ast.SelectorExpr)
		if !ok {
			return true
		}
		switch selector.Sel.Name {
		case "NewTicker", "NewCommsSender", "NewSQSQueueClient", "NewCommsEventConsumer", "Loop":
			count++
			if !inside(call.Pos(), jobs) && !(selector.Sel.Name == "NewTicker" && inside(call.Pos(), nowJobs)) {
				t.Errorf("background %s escaped the read-only guard", selector.Sel.Name)
			}
		case "NewStripeGateway", "NewKYCS3", "NewKYCOCR", "NewCognitoAdmin":
			if !inside(call.Pos(), providers) {
				t.Errorf("provider %s escaped the read-only guard", selector.Sel.Name)
			}
		}
		return true
	})
	if count < 8 {
		t.Fatal("test did not locate the expected background jobs")
	}
}
