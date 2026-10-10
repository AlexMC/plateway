"""Synthetic dimensions exercise digital geometry ONLY; never use for physical fit."""

import pytest


@pytest.fixture
def connector_request():
    return {
        "version": 1, "units": "mm", "family": "connector_coupon",
        "parameters": {
            "body_length": 40, "body_width": 24, "base_thickness": 4,
            "rail_gauge": 16, "rail_width": 2, "rail_height": 2,
            "tongue_length": 4.5, "tongue_width": 6, "tongue_height": 2,
            "socket_clearance": 0.2, "socket_depth": 5,
        },
        "printer_envelope": {"x": 100, "y": 100, "z": 100},
        "part_revision": "synthetic-coupon-1", "layout_revision": "synthetic-layout-1",
    }


@pytest.fixture
def transition_request():
    return {
        "version": 1, "units": "mm", "family": "vertical_transition",
        "parameters": {
            "run": 80, "rise": 8, "start_grade": 0, "end_grade": 0,
            "body_width": 24, "base_thickness": 4, "rail_gauge": 16,
            "rail_interface_width": 2, "rail_height": 2,
            "joint_width": 6, "joint_depth": 5, "joint_height": 2, "joint_clearance": .2,
        },
        "printer_envelope": {"x": 100, "y": 100, "z": 100},
        "part_revision": "synthetic-grade-1", "layout_revision": "synthetic-layout-1",
    }
