package main

import (
	"go/ast"
	"go/parser"
	"go/token"
	"testing"
)

func TestReadOnlyStartupWrapsRouterAndGuardsBMP(t *testing.T) {
	f, err := parser.ParseFile(token.NewFileSet(), "main.go", nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	wrapped, guarded := false, false
	ast.Inspect(f, func(n ast.Node) bool {
		if call, ok := n.(*ast.CallExpr); ok {
			if selector, ok := call.Fun.(*ast.SelectorExpr); ok && selector.Sel.Name == "ReadOnlyHandler" {
				wrapped = true
			}
		}
		statement, ok := n.(*ast.IfStmt)
		if !ok {
			return true
		}
		providerGuard := false
		ast.Inspect(statement.Cond, func(n ast.Node) bool {
			if call, ok := n.(*ast.CallExpr); ok {
				if selector, ok := call.Fun.(*ast.SelectorExpr); ok && selector.Sel.Name == "ExternalProvidersEnabled" {
					providerGuard = true
				}
			}
			return true
		})
		if providerGuard {
			ast.Inspect(statement.Body, func(n ast.Node) bool {
				if call, ok := n.(*ast.CallExpr); ok {
					if selector, ok := call.Fun.(*ast.SelectorExpr); ok && selector.Sel.Name == "NewBMPClient" {
						guarded = true
					}
				}
				return true
			})
		}
		return true
	})
	if !wrapped || !guarded {
		t.Fatal("read-only must wrap every request and never create a BMP client")
	}
}
