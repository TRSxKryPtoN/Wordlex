package com.wordlex.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Offline rooms: the host phone runs a small local server (see LocalRoomPlugin).
        registerPlugin(LocalRoomPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
