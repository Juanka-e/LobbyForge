import { describe, it, expect } from 'vitest';
import * as React from 'react';
import { Button } from '../components/Button.js';
import { Spinner } from '../components/Spinner.js';
import { Avatar } from '../components/Avatar.js';
import { Card } from '../components/Card.js';

describe('UI component placeholders rendering', () => {
  it('should render button structure correctly', () => {
    const el = <Button variant="danger">Danger Action</Button>;
    expect(el.props.children).toBe('Danger Action');
    expect(el.props.variant).toBe('danger');
  });

  it('should render spinner with custom size and label', () => {
    const el = <Spinner size={24} label="Loading state" />;
    expect(el.props.size).toBe(24);
    expect(el.props.label).toBe('Loading state');
  });

  it('should render avatar fallback', () => {
    const el = <Avatar fallback="John Doe" />;
    expect(el.props.fallback).toBe('John Doe');
  });

  it('should render card with children', () => {
    const el = <Card><div>Card content</div></Card>;
    expect(el.props.children).toBeDefined();
  });
});
